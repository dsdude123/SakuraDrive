"""Tests for sakuradrive-netperf.py. Run with: python3 -m unittest discover -s clients"""

import http.server
import importlib.util
import io
import json
import os
import shutil
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location('netperf', os.path.join(_HERE, 'sakuradrive-netperf.py'))
netperf = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(netperf)

MiB = 1024 * 1024


class MeasureTests(unittest.TestCase):
    def setUp(self):
        self.share = tempfile.mkdtemp(prefix='netperf-share-')

    def tearDown(self):
        shutil.rmtree(self.share, ignore_errors=True)

    def test_measures_and_leaves_nothing_behind(self):
        result = netperf.measure(self.share, 8 * MiB, 5)
        self.assertIsNone(result['error'])
        self.assertGreater(result['writeMBps'], 0)
        self.assertGreater(result['readMBps'], 0)
        self.assertGreater(result['latencyMs'], 0)
        self.assertGreaterEqual(result['latencyP95Ms'], result['latencyMs'])
        self.assertEqual(result['bytesTested'], 16 * MiB)
        self.assertEqual(os.listdir(self.share), [])

    def test_rounds_the_size_up_to_whole_chunks(self):
        # Unbuffered reads on Windows need sector-aligned sizes; whole chunks guarantee it.
        result = netperf.measure(self.share, 1, 2)
        self.assertEqual(result['bytesTested'], 2 * netperf.CHUNK)

    def test_reports_an_unreachable_share_rather_than_raising(self):
        result = netperf.measure(os.path.join(self.share, 'missing'), MiB, 2)
        self.assertIn('not reachable', result['error'])
        self.assertIsNone(result['writeMBps'])

    def test_cleans_up_when_the_read_fails_part_way(self):
        def broken_reader(path, platform):
            raise OSError(5, 'Input/output error')

        result = netperf.measure(self.share, 4 * MiB, 2, reader=broken_reader)
        self.assertIn('Input/output error', result['error'])
        self.assertIsNotNone(result['writeMBps'])
        self.assertEqual(os.listdir(self.share), [])


class ReadBackTests(unittest.TestCase):
    def setUp(self):
        handle, self.path = tempfile.mkstemp()
        os.write(handle, os.urandom(netperf.CHUNK))
        os.close(handle)

    def tearDown(self):
        os.remove(self.path)

    @unittest.skipUnless(hasattr(os, 'posix_fadvise'), 'posix_fadvise is Linux-only')
    def test_linux_drops_the_file_from_the_cache(self):
        total, may_be_cached = netperf.read_back(self.path, 'linux')
        self.assertEqual(total, netperf.CHUNK)
        self.assertFalse(may_be_cached)

    def test_falls_back_and_says_so_when_the_windows_path_fails(self):
        # Off Windows there is no WinDLL, so the unbuffered path fails for real here --
        # which is exactly the failure the fallback exists for.
        total, may_be_cached = netperf.read_back(self.path, 'win32')
        self.assertEqual(total, netperf.CHUNK)
        self.assertTrue(may_be_cached)

    def test_an_unknown_platform_reads_and_flags_the_result(self):
        total, may_be_cached = netperf.read_back(self.path, 'sunos5')
        self.assertEqual(total, netperf.CHUNK)
        self.assertTrue(may_be_cached)


class PercentileTests(unittest.TestCase):
    def test_matches_the_servers_nearest_rank_definition(self):
        values = list(range(1, 101))
        self.assertEqual(netperf.percentile(values, 95), 95)
        self.assertEqual(netperf.percentile(values, 50), 50)
        self.assertEqual(netperf.percentile([7.0], 95), 7.0)
        self.assertIsNone(netperf.percentile([], 95))


class _Recorder(http.server.BaseHTTPRequestHandler):
    received = []
    status = 200

    def do_POST(self):  # noqa: N802 - the name http.server wants
        body = self.rfile.read(int(self.headers['Content-Length']))
        _Recorder.received.append((self.path, dict(self.headers), json.loads(body)))
        self.send_response(_Recorder.status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"accepted": true}')

    def log_message(self, *args):
        pass


class MainTests(unittest.TestCase):
    def setUp(self):
        self.share = tempfile.mkdtemp(prefix='netperf-share-')
        _Recorder.received = []
        _Recorder.status = 200
        self.server = http.server.HTTPServer(('127.0.0.1', 0), _Recorder)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = 'http://127.0.0.1:{}'.format(self.server.server_address[1])

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.share, ignore_errors=True)

    def run_main(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            try:
                code = netperf.main(list(args))
            except SystemExit as exit_:
                code = exit_.code
        return code, out.getvalue(), err.getvalue()

    def test_submits_the_result_with_the_token(self):
        code, out, _ = self.run_main(
            '--server', self.url + '/', '--token', 'tok-123', '--share', self.share,
            '--size-mb', '4', '--samples', '3', '--client', 'laptop',
        )
        self.assertEqual(code, 0)
        self.assertIn('MB/s', out)
        path, headers, body = _Recorder.received[0]
        self.assertEqual(path, '/api/agent/perf/network')
        self.assertEqual(headers['Authorization'], 'Bearer tok-123')
        self.assertEqual(body['client'], 'laptop')
        self.assertEqual(body['share'], self.share)
        self.assertGreater(body['writeMBps'], 0)

    def test_says_when_the_server_refuses(self):
        _Recorder.status = 401
        code, _, err = self.run_main(
            '--server', self.url, '--token', 'wrong', '--share', self.share, '--size-mb', '4', '--samples', '2',
        )
        self.assertEqual(code, 2)
        self.assertIn('HTTP 401', err)

    def test_needs_a_server_and_token_unless_told_not_to_submit(self):
        code, _, err = self.run_main('--share', self.share)
        self.assertEqual(code, 2)
        self.assertIn('--server and --token are required', err)

    def test_can_measure_without_submitting(self):
        code, out, _ = self.run_main('--share', self.share, '--size-mb', '4', '--samples', '2', '--no-submit', '--json')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)['share'], self.share)
        self.assertEqual(_Recorder.received, [])

    def test_exits_non_zero_when_the_test_itself_failed(self):
        code, _, _ = self.run_main('--share', os.path.join(self.share, 'missing'), '--no-submit')
        self.assertEqual(code, 1)


if __name__ == '__main__':
    unittest.main()
