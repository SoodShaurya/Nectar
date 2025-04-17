'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { io, Socket } from 'socket.io-client';
import TWEEN from '@tweenjs/tween.js';

// Basic Player Skin Mesh (Placeholder - replace with actual skin rendering later if needed)
function createPlayerMesh() {
    const geometry = new THREE.BoxGeometry(0.6, 1.8, 0.6); // Standard player dimensions
    const material = new THREE.MeshBasicMaterial({ color: 0xaaaaaa });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = 0.9; // Pivot at the feet
    return mesh;
}

interface BotViewerProps {
    botId: string | null;
    onClose: () => void;
}

const BotViewer: React.FC<BotViewerProps> = ({ botId, onClose }) => {
    const mountRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const botMeshRef = useRef<THREE.Mesh | null>(null);
    const socketRef = useRef<Socket | null>(null);
    const animationFrameId = useRef<number | null>(null);
    const primitivesRef = useRef<{ [id: string]: THREE.Object3D }>({}); // Store primitive objects

    useEffect(() => {
        if (!botId || !mountRef.current) return;

        // Determine backend URL (similar to page.tsx, but could be simplified if always localhost)
        const backendProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const backendHost = window.location.hostname;
        const backendPort = 6900;
        const viewerUrl = `${backendProtocol}//${backendHost}:${backendPort}/viewer`;
        console.log(`Connecting BotViewer to ${viewerUrl}`);


        // --- Socket.IO Setup ---
        const socket = io(viewerUrl, { // Connect explicitly to the backend viewer namespace
            // path: '/socket.io', // Default path is usually fine unless server configured differently
            reconnection: true,
        });
        socketRef.current = socket;

        socket.on('connect', () => {
            console.log('Viewer connected to /viewer namespace:', socket.id);
            socket.emit('identifyAsClient');
            socket.emit('subscribeToBot', { botId });
            console.log(`Subscribed to bot ${botId}`);
        });

        socket.on('disconnect', (reason) => {
            console.log('Viewer disconnected from /viewer namespace:', reason);
        });

        socket.on('connect_error', (err) => {
            console.error('Viewer connection error:', err);
        });

        // --- Three.js Setup ---
        const currentMount = mountRef.current;
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xabcdef);
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(75, currentMount.clientWidth / currentMount.clientHeight, 0.1, 1000);
        camera.position.set(5, 5, 5); // Initial camera position
        cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(currentMount.clientWidth, currentMount.clientHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        currentMount.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        // Basic lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambientLight);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(5, 10, 7.5);
        scene.add(directionalLight);

        // Orbit Controls
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.1;
        controls.target.set(0, 1, 0); // Look towards player height initially
        controlsRef.current = controls;

        // Bot Mesh Placeholder
        const botMesh = createPlayerMesh();
        botMesh.visible = false; // Initially hidden until position received
        scene.add(botMesh);
        botMeshRef.current = botMesh;

        // Grid Helper
        const gridHelper = new THREE.GridHelper(100, 100);
        scene.add(gridHelper);

        // Resize Handler
        const handleResize = () => {
            if (cameraRef.current && rendererRef.current && currentMount) {
                cameraRef.current.aspect = currentMount.clientWidth / currentMount.clientHeight;
                cameraRef.current.updateProjectionMatrix();
                rendererRef.current.setSize(currentMount.clientWidth, currentMount.clientHeight);
            }
        };
        window.addEventListener('resize', handleResize);

        // Animation Loop
        const animate = () => {
            animationFrameId.current = requestAnimationFrame(animate);
            TWEEN.update();
            controlsRef.current?.update();
            if (sceneRef.current && cameraRef.current && rendererRef.current) {
                rendererRef.current.render(sceneRef.current, cameraRef.current);
            }
        };
        animate();

        // --- Socket Event Listener ---
        socket.on('viewerUpdate', (payload: { type: string; data: any }) => {
            // console.log('Received viewerUpdate:', payload); // DEBUG
            if (!sceneRef.current || !botMeshRef.current) return;

            switch (payload.type) {
                case 'position': {
                    const { pos, yaw, pitch, addMesh } = payload.data;
                    if (addMesh && botMeshRef.current) {
                        botMeshRef.current.visible = true;
                        // Use TWEEN for smooth position updates
                        new TWEEN.Tween(botMeshRef.current.position)
                            .to({ x: pos.x, y: pos.y + 0.9, z: pos.z }, 50) // Adjust y for pivot
                            .easing(TWEEN.Easing.Linear.None)
                            .start();

                        // Smooth rotation (handle wrap-around)
                        const currentYaw = botMeshRef.current.rotation.y;
                        const targetYaw = -yaw; // Adjust based on model orientation if needed
                        const deltaYaw = (targetYaw - currentYaw);
                        const shortestAngleYaw = ((deltaYaw + Math.PI) % (Math.PI * 2)) - Math.PI;

                        new TWEEN.Tween(botMeshRef.current.rotation)
                            .to({ y: currentYaw + shortestAngleYaw }, 50)
                            .easing(TWEEN.Easing.Linear.None)
                            .start();

                        // TODO: Handle pitch for first-person view if implemented
                        // TODO: Center controls target on first update?
                    }
                    break;
                }
                case 'primitive': {
                    const { id, type, ...params } = payload.data;
                    const existingPrimitive = primitivesRef.current[id];

                    if (!type && existingPrimitive) { // Erase command (no type means erase)
                        sceneRef.current.remove(existingPrimitive);
                        delete primitivesRef.current[id];
                        // Dispose geometry/material if necessary
                    } else if (type) {
                        if (existingPrimitive) { // Update existing
                            sceneRef.current.remove(existingPrimitive);
                            // Dispose old geometry/material? Depends on primitive type
                        }
                        // Create new primitive based on type
                        let newPrimitive: THREE.Object3D | null = null;
                        try {
                            if (type === 'line') {
                                const { points, color } = params;
                                const material = new THREE.LineBasicMaterial({ color: color || 0xff0000 });
                                const geometry = new THREE.BufferGeometry().setFromPoints(
                                    points.map((p: { x: number, y: number, z: number }) => new THREE.Vector3(p.x, p.y, p.z))
                                );
                                newPrimitive = new THREE.Line(geometry, material);
                            } else if (type === 'boxgrid') {
                                // TODO: Implement box grid drawing (e.g., using multiple boxes or lines)
                                console.warn('BoxGrid primitive not fully implemented yet');
                            } else if (type === 'points') {
                                // TODO: Implement points drawing (e.g., using THREE.Points)
                                console.warn('Points primitive not fully implemented yet');
                            }
                            // Add other primitive types as needed

                            if (newPrimitive) {
                                sceneRef.current.add(newPrimitive);
                                primitivesRef.current[id] = newPrimitive;
                            }
                        } catch (error) {
                            console.error(`Error creating primitive ${id} of type ${type}:`, error);
                        }
                    }
                    break;
                }
                // TODO: Handle chunk data, entities, etc.
            }
        });

        // --- Cleanup ---
        return () => {
            console.log(`Unsubscribing from bot ${botId}`);
            socket.emit('unsubscribeFromBot', { botId });
            socket.disconnect();
            socketRef.current = null;

            window.removeEventListener('resize', handleResize);
            if (animationFrameId.current) {
                cancelAnimationFrame(animationFrameId.current);
            }
            controlsRef.current?.dispose();
            rendererRef.current?.dispose();
            // Dispose scene objects, geometries, materials
            Object.values(primitivesRef.current).forEach(obj => sceneRef.current?.remove(obj));
            primitivesRef.current = {};
            if (botMeshRef.current) sceneRef.current?.remove(botMeshRef.current);
            // TODO: More thorough cleanup of Three.js resources

            if (currentMount) {
                currentMount.innerHTML = ''; // Clear the mount point
            }
            sceneRef.current = null;
            cameraRef.current = null;
            rendererRef.current = null;
            controlsRef.current = null;
            botMeshRef.current = null;
        };

    }, [botId]); // Re-run effect if botId changes

    if (!botId) return null; // Don't render if no bot is selected

    return (
        <div style={{
            position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
            backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
            <div style={{
                width: '80%', height: '80%', backgroundColor: 'white',
                position: 'relative', border: '1px solid #ccc'
            }}>
                <button onClick={onClose} style={{ position: 'absolute', top: '10px', right: '10px', zIndex: 10 }}>
                    Close
                </button>
                <div ref={mountRef} style={{ width: '100%', height: '100%' }}></div>
            </div>
        </div>
    );
};

export default BotViewer;
