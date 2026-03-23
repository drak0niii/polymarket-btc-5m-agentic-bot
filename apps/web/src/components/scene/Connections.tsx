import { Line } from '@react-three/drei';

interface ConnectionNode {
  id: string;
  position: [number, number, number];
}

interface ConnectionsProps {
  nodes: ConnectionNode[];
}

const connectionPairs: Array<[string, string]> = [
  ['market', 'signal'],
  ['signal', 'risk'],
  ['risk', 'execution'],
  ['execution', 'portfolio'],
  ['market', 'portfolio'],
];

export function Connections({ nodes }: ConnectionsProps) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  return (
    <>
      {connectionPairs.map(([fromId, toId]) => {
        const from = nodeMap.get(fromId);
        const to = nodeMap.get(toId);

        if (!from || !to) {
          return null;
        }

        return (
          <Line
            key={`${fromId}-${toId}`}
            points={[from.position, to.position]}
            color="#6A4BFF"
            transparent
            opacity={0.32}
            lineWidth={1.2}
          />
        );
      })}
    </>
  );
}