import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid } from '@react-three/drei';
import { FloatingNode } from './FloatingNode';
import { Connections } from './Connections';
import { MiniMap } from './MiniMap';
import { SceneLegend } from './SceneLegend';

const nodes = [
  { id: 'market', position: [-6, 1.2, 4] as [number, number, number], color: '#4D6BFF', label: 'market' },
  { id: 'signal', position: [-1, 1.5, 1] as [number, number, number], color: '#E267FF', label: 'signal' },
  { id: 'risk', position: [3, 1.3, -1] as [number, number, number], color: '#FF6B8A', label: 'risk' },
  { id: 'execution', position: [8, 1.4, 2] as [number, number, number], color: '#7A8CFF', label: 'execution' },
  { id: 'portfolio', position: [1, 0.8, 6] as [number, number, number], color: '#9B7BFF', label: 'portfolio' },
];

export function Scene3D() {
  return (
    <div style={{ position: 'relative', minHeight: 720 }}>
      <Canvas className="scene-canvas" gl={{ antialias: true }}>
        <color attach="background" args={['#05060C']} />
        <fog attach="fog" args={['#05060C', 14, 42]} />
        <ambientLight intensity={0.65} />
        <pointLight position={[0, 18, 0]} intensity={10} color="#8A74FF" />
        <pointLight position={[-8, 6, 8]} intensity={5} color="#FF55C7" />
        <pointLight position={[10, 4, -2]} intensity={6} color="#57C8FF" />

        <Grid
          args={[40, 40]}
          position={[0, -0.02, 0]}
          sectionColor="#3527A8"
          cellColor="#131933"
          fadeDistance={38}
          fadeStrength={1}
          infiniteGrid
        />

        <Connections nodes={nodes} />
        {nodes.map((node) => (
          <FloatingNode
            key={node.id}
            position={node.position}
            color={node.color}
            label={node.label}
          />
        ))}

        <OrbitControls enableDamping dampingFactor={0.08} minDistance={8} maxDistance={36} />
      </Canvas>

      <div style={{ position: 'absolute', left: 16, bottom: 16 }}>
        <MiniMap />
      </div>

      <div style={{ position: 'absolute', right: 16, bottom: 16 }}>
        <SceneLegend />
      </div>
    </div>
  );
}