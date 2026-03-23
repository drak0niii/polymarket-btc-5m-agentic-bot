import { Html, Edges } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Group } from 'three';

interface FloatingNodeProps {
  position: [number, number, number];
  color: string;
  label: string;
}

export function FloatingNode({
  position,
  color,
  label,
}: FloatingNodeProps) {
  const ref = useRef<Group | null>(null);

  useFrame((state) => {
    if (!ref.current) {
      return;
    }

    ref.current.position.y =
      position[1] + Math.sin(state.clock.elapsedTime * 1.1 + position[0]) * 0.06;

    ref.current.rotation.y += 0.002;
  });

  return (
    <group ref={ref} position={position}>
      <mesh>
        <boxGeometry args={[2.4, 2.0, 2.0]} />
        <meshStandardMaterial
          color={color}
          transparent
          opacity={0.62}
          emissive={color}
          emissiveIntensity={0.45}
          roughness={0.25}
          metalness={0.28}
        />
        <Edges color={color} scale={1.02} />
      </mesh>

      <Html distanceFactor={12} position={[0, 1.5, 0]}>
        <div
          style={{
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 12,
            background: 'rgba(0,0,0,0.72)',
            padding: '6px 10px',
            color: 'rgba(255,255,255,0.92)',
            fontSize: 10,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
            backdropFilter: 'blur(12px)',
          }}
        >
          {label}
        </div>
      </Html>
    </group>
  );
}