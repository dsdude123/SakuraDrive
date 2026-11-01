#!/usr/bin/env python3
"""
SakuraDrive network benchmark.

Run this on a machine that uses the shares, pointed at a share, and it measures what that
machine actually gets: sequential write and read throughput over the network, and the
latency of creating and removing a small file. The result goes to the SakuraDrive server
so it sits next to the disk and pool figures.

    python3 sakuradrive-netperf.py --server http://tokyo-3:8099 --token <agent token> \\
        --share '\\\\tokyo-3\\Tier1'

Standard library only, Python 3.8 or later, on Windows, macOS and Linux. The token is an
agent token from Settings -> Agents. The test writes one temporary file into the share,
reads it back and deletes it.

Reading a file straight after writing it usually measures the client's own cache rather
than the network. Each platform gets its best available way around that; where none
works the read figure is still sent, marked as possibly cached.
"""

import argparse
import json
import os
import random
import socket
import statistics
import sys
import time
import urllib.error
import urllib.request

VERSION = '1'
CHUNK = 4 * 1024 * 1024
SMALL = 4096


def percentile(values, p):
    """Nearest-rank percentile, the same definition the server uses."""
    ordered = sorted(values)
    if not ordered:
        return None
    rank = max(1, min(len(ordered), -(-len(ordered) * p // 100)))
    return ordered[int(rank) - 1]


def mbps(byte_count, seconds):
    return byte_count / 1e6 / seconds if seconds > 0 else None


def _read_buffered(path, drop_cache):
    """Read the whole file; returns (bytes, uncached). `drop_cache` is tried first."""
    with open(path, 'rb', buffering=0) as handle:
        uncached = False
        try:
            uncached = drop_cache(handle.fileno())
        except (OSError, AttributeError, ValueError):
            uncached = False
        total = 0
        while True:
            block = handle.read(CHUNK)
            if not block:
                break
            total += len(block)
        return total, uncached


def _drop_linux(fd):
    # Drops this file's clean pages from the page cache, network filesystems included.
    os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
    return True


def _drop_darwin(fd):
    import fcntl
    fcntl.fcntl(fd, getattr(fcntl, 'F_NOCACHE', 48), 1)
    return True


def _no_drop(_fd):
    return False


def _read_unbuffered_windows(path):
    """
    Read with FILE_FLAG_NO_BUFFERING, so the SMB redirector goes to the server rather
    than to the client's cache. That flag needs a sector-aligned buffer, which is why the
    buffer comes from VirtualAlloc (page aligned) rather than from Python.
    """
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    ]
    kernel32.VirtualAlloc.restype = wintypes.LPVOID
    kernel32.VirtualAlloc.argtypes = [wintypes.LPVOID, ctypes.c_size_t, wintypes.DWORD, wintypes.DWORD]
    kernel32.VirtualFree.restype = wintypes.BOOL
    kernel32.VirtualFree.argtypes = [wintypes.LPVOID, ctypes.c_size_t, wintypes.DWORD]
    kernel32.ReadFile.restype = wintypes.BOOL
    kernel32.ReadFile.argtypes = [
        wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID,
    ]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    generic_read, share_read, open_existing = 0x80000000, 0x00000001, 3
    no_buffering, sequential = 0x20000000, 0x08000000
    commit_reserve, release, read_write = 0x3000, 0x8000, 0x04
    invalid = wintypes.HANDLE(-1).value

    handle = kernel32.CreateFileW(path, generic_read, share_read, None, open_existing, no_buffering | sequential, None)
    if not handle or handle == invalid:
        raise OSError(ctypes.get_last_error(), 'CreateFileW failed')
    buffer = kernel32.VirtualAlloc(None, CHUNK, commit_reserve, read_write)
    if not buffer:
        kernel32.CloseHandle(handle)
        raise OSError(ctypes.get_last_error(), 'VirtualAlloc failed')
    total = 0
    try:
        done = wintypes.DWORD(0)
        while True:
            if not kernel32.ReadFile(handle, buffer, CHUNK, ctypes.byref(done), None):
                raise OSError(ctypes.get_last_error(), 'ReadFile failed')
            if done.value == 0:
                break
            total += done.value
    finally:
        kernel32.VirtualFree(buffer, 0, release)
        kernel32.CloseHandle(handle)
    return total


def read_back(path, platform=None):
    """Read `path` as uncached as this platform allows. Returns (bytes, may_be_cached)."""
    platform = platform or sys.platform
    if platform == 'win32':
        try:
            return _read_unbuffered_windows(path), False
        except Exception:  # noqa: BLE001 - any failure here falls back, it must not abort the test
            total, _ = _read_buffered(path, _no_drop)
            return total, True
    drop = _drop_linux if platform.startswith('linux') else _drop_darwin if platform == 'darwin' else _no_drop
    total, uncached = _read_buffered(path, drop)
    return total, not uncached


def measure(share, size_bytes, samples, platform=None, reader=None):
    """Benchmark `share`. Every file created is removed again, whatever happens."""
    result = {
        'bytesTested': 0,
        'writeMBps': None,
        'readMBps': None,
        'latencyMs': None,
        'latencyP95Ms': None,
        'readMayBeCached': False,
        'error': None,
    }
    if not os.path.isdir(share):
        result['error'] = 'The share is not reachable from this machine: {}'.format(share)
        return result

    size_bytes = max(CHUNK, -(-size_bytes // CHUNK) * CHUNK)
    tag = '{}-{:08x}'.format(socket.gethostname().split('.')[0] or 'client', random.getrandbits(32))
    bulk = os.path.join(share, '.sakuradrive-netperf-{}.tmp'.format(tag))
    small = os.path.join(share, '.sakuradrive-netperf-{}-small.tmp'.format(tag))
    # Random rather than zeros, so nothing along the way can compress its way to a number.
    chunk = os.urandom(CHUNK)

    try:
        start = time.perf_counter()
        with open(bulk, 'xb', buffering=0) as handle:
            written = 0
            while written < size_bytes:
                written += handle.write(chunk)
            os.fsync(handle.fileno())
        result['writeMBps'] = mbps(size_bytes, time.perf_counter() - start)
        result['bytesTested'] = size_bytes

        start = time.perf_counter()
        read, may_be_cached = (reader or read_back)(bulk, platform)
        result['readMBps'] = mbps(read, time.perf_counter() - start)
        result['readMayBeCached'] = may_be_cached
        result['bytesTested'] += read

        block = chunk[:SMALL]
        timings = []
        for _ in range(samples):
            start = time.perf_counter()
            with open(small, 'xb', buffering=0) as handle:
                handle.write(block)
                os.fsync(handle.fileno())
            os.remove(small)
            timings.append((time.perf_counter() - start) * 1000)
        result['latencyMs'] = statistics.median(timings) if timings else None
        result['latencyP95Ms'] = percentile(timings, 95)
    except OSError as error:
        result['error'] = '{}: {}'.format(type(error).__name__, error)
    finally:
        for path in (bulk, small):
            try:
                os.remove(path)
            except OSError:
                pass
    return result


def submit(server, token, payload, timeout=30):
    request = urllib.request.Request(
        server.rstrip('/') + '/api/agent/perf/network',
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token},
        method='POST',
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode('utf-8') or '{}')


def describe(result):
    if result['error']:
        return 'Failed: ' + result['error']

    def fixed(value, digits=0):
        return '?' if value is None else '{:.{}f}'.format(value, digits)

    cached = ' (possibly from this machine\'s cache)' if result['readMayBeCached'] else ''
    return 'Write {} MB/s, read {} MB/s{}, small file {} ms (p95 {} ms)'.format(
        fixed(result['writeMBps']), fixed(result['readMBps']), cached,
        fixed(result['latencyMs'], 1), fixed(result['latencyP95Ms'], 1),
    )


def main(argv=None):
    parser = argparse.ArgumentParser(description='Benchmark an SMB share and report the result to SakuraDrive.')
    parser.add_argument('--server', help='SakuraDrive address, e.g. http://tokyo-3:8099')
    parser.add_argument('--token', help='An agent token from Settings -> Agents')
    parser.add_argument('--share', required=True, help=r'The share, e.g. \\tokyo-3\Tier1 or /Volumes/Tier1')
    parser.add_argument('--size-mb', type=int, default=256, help='Size of the test file (default 256)')
    parser.add_argument('--samples', type=int, default=30, help='Small files timed for latency (default 30)')
    parser.add_argument('--client', default=socket.gethostname(), help='Name to report this machine as')
    parser.add_argument('--no-submit', action='store_true', help='Measure and print, but do not report')
    parser.add_argument('--json', action='store_true', help='Print the result as JSON')
    parser.add_argument('--version', action='version', version='sakuradrive-netperf ' + VERSION)
    args = parser.parse_args(argv)

    if not args.no_submit and not (args.server and args.token):
        parser.error('--server and --token are required unless --no-submit is given')

    result = measure(args.share, max(1, args.size_mb) * 1024 * 1024, max(1, args.samples))
    payload = dict(result, client=args.client, platform=sys.platform, share=args.share, clientVersion=VERSION)

    print(json.dumps(payload, indent=2) if args.json else '{}: {}'.format(args.share, describe(result)))

    if not args.no_submit:
        try:
            submit(args.server, args.token, payload)
        except urllib.error.HTTPError as error:
            print('The server refused the result: HTTP {} {}'.format(error.code, error.reason), file=sys.stderr)
            return 2
        except (urllib.error.URLError, OSError) as error:
            print('Could not reach the server: {}'.format(error), file=sys.stderr)
            return 2

    return 1 if result['error'] else 0


if __name__ == '__main__':
    sys.exit(main())
