import { useState } from 'react';
import { formatBytes, formatCount, type ScanRoot, type TreemapNode } from '@sakuradrive/shared';
import { PageHeader } from '../components/Layout.js';
import { Treemap } from '../components/Treemap.js';
import { Badge, Banner, Card, EmptyState, Loading } from '../components/ui.js';
import { useQuery } from '../hooks/useApi.js';
import { Breadcrumbs } from './Catalog.js';

interface RootWithStats extends ScanRoot {
  stats: { files: number; bytes: number; effectiveBytes: number };
}

interface TreemapResponse {
  rootId: string;
  path: string;
  metric: 'effective' | 'logical';
  totalBytes: number;
  nodes: TreemapNode[];
}

const WIDTH = 1200;
const HEIGHT = 640;

export function StoragePage(): JSX.Element {
  const roots = useQuery<{ roots: RootWithStats[] }>('/api/catalog/roots');
  const [rootId, setRootId] = useState('');
  const [path, setPath] = useState('');
  const [metric, setMetric] = useState<'effective' | 'logical'>('effective');
  const [depth, setDepth] = useState(2);
  const [hovered, setHovered] = useState<TreemapNode | null>(null);

  const activeRoot = roots.data?.roots.find((root) => root.id === rootId) ?? roots.data?.roots[0];
  const currentRootId = activeRoot?.id ?? '';

  const { data, loading } = useQuery<TreemapResponse>(currentRootId ? '/api/storage/treemap' : null, {
    query: { rootId: currentRootId, path, width: WIDTH, height: HEIGHT, depth, metric },
  });

  return (
    <>
      <PageHeader
        title="Storage map"
        subtitle="Where the space actually goes, with DrivePool duplication accounted for"
        actions={
          <>
            <select value={currentRootId} onChange={(event) => { setRootId(event.target.value); setPath(''); }}>
              {roots.data?.roots.map((root) => (
                <option key={root.id} value={root.id}>
                  {root.name}
                </option>
              ))}
            </select>
            <select value={metric} onChange={(event) => setMetric(event.target.value as typeof metric)}>
              <option value="effective">Space on pool (duplication applied)</option>
              <option value="logical">Logical size</option>
            </select>
            <select value={depth} onChange={(event) => setDepth(Number(event.target.value))}>
              <option value={0}>1 level</option>
              <option value={1}>2 levels</option>
              <option value={2}>3 levels</option>
              <option value={3}>4 levels</option>
            </select>
          </>
        }
      />
      <div className="content">
        {roots.data?.roots.length === 0 && (
          <EmptyState title="Nothing catalogued yet">
            Configure a catalog root and run a scan; the map is built from the catalog, so it costs
            nothing to draw.
          </EmptyState>
        )}

        {metric === 'effective' && (
          <Banner tone="info">
            Sizes include duplication: a 1&nbsp;GB file in a folder set to 2× duplication is shown as
            2&nbsp;GB, because that is what it costs the pool.
          </Banner>
        )}

        {currentRootId && (
          <Card
            flush
            title={
              <div className="row">
                <Breadcrumbs path={path} onNavigate={setPath} />
              </div>
            }
            description={
              data
                ? `${formatBytes(data.totalBytes)} total · click a rectangle to zoom in`
                : undefined
            }
            actions={
              hovered ? (
                <Badge tone="accent">
                  {hovered.name} · {formatBytes(hovered.value)}
                  {(hovered.meta as { fileCount?: number } | undefined)?.fileCount
                    ? ` · ${formatCount((hovered.meta as { fileCount: number }).fileCount)} files`
                    : ''}
                </Badge>
              ) : undefined
            }
          >
            <div style={{ padding: 12 }}>
              {loading && !data && <Loading />}
              {data && data.nodes.length === 0 && (
                <EmptyState title="Nothing to show here">
                  This directory has no catalogued files.
                </EmptyState>
              )}
              {data && data.nodes.length > 0 && (
                <Treemap
                  nodes={data.nodes}
                  width={WIDTH}
                  height={HEIGHT}
                  onOpen={setPath}
                  onHover={setHovered}
                />
              )}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
