'use client'; // Required for hooks like useState, useEffect

'use client'; // Required for hooks like useState, useEffect

import React, { useState, useEffect, useCallback } from 'react';
import { useWebSocket, Bot } from '@/hooks/useWebSocket'; // Import the hook and Bot type
import BotList from '@/components/BotList';
import BotViewer from '@/components/BotViewer'; // Import the new viewer component

export default function Home() {
    // State for form inputs
    const [serverAddress, setServerAddress] = useState('localhost'); // Default to localhost
    const [serverPort, setServerPort] = useState('6900'); // Default to backend port
    const [username, setUsername] = useState('');
    const [version, setVersion] = useState(''); // e.g., 1.20.1

    // State for application data (managed by the hook now)
    // const [bots, setBots] = useState<Bot[]>([]); // Managed by useWebSocket
    // const [availableActivities, setAvailableActivities] = useState<string[]>([]); // Managed by useWebSocket
    const [connectionMessage, setConnectionMessage] = useState('Determining WebSocket URL...');
    const [wsUrl, setWsUrl] = useState<string | null>(null);
    const [viewingBotId, setViewingBotId] = useState<string | null>(null); // State for viewer modal

    // Determine WebSocket URL on client-side mount (use current host, fixed port)
    useEffect(() => {
        // This code runs only in the browser
        // Construct the URL for the backend Socket.IO server (port 6900)
        const backendProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const backendHost = window.location.hostname; // Assumes backend is on the same host
        const backendPort = 6900; // Explicitly use the backend port
        const url = `${backendProtocol}//${backendHost}:${backendPort}`;
        console.log(`Manager WebSocket URL determined: ${url}`);
        setWsUrl(url);
        setConnectionMessage('Connecting to manager server...');
    }, []);

    // Initialize WebSocket connection using the hook
    // The hook now returns the state directly
    const { bots, activities: availableActivities, isConnected, error, sendMessage } = useWebSocket(wsUrl);

    // Update connection message based on hook state
    useEffect(() => {
        if (error) {
            // Error is now just a string or null from the hook
            setConnectionMessage(`Error: ${error}`);
        } else if (isConnected) {
            setConnectionMessage('Connected.');
            // Clear the message after a short delay
            const timer = setTimeout(() => setConnectionMessage(''), 3000);
            return () => clearTimeout(timer);
        } else if (wsUrl) {
            setConnectionMessage('Connecting...');
        } else {
            setConnectionMessage('Determining server address...'); // Initial state before wsUrl is set
        }
    }, [isConnected, error, wsUrl]);

    // No longer need useEffect for lastMessage or handleServerMessage
    // The hook manages state updates internally via socket event listeners.

    const handleCreateBot = useCallback(() => {
        if (!serverAddress || !serverPort || !username) {
            alert('Please fill in Server Address (use "localhost" for local server), Port, and Bot Username.');
            return;
        }
        const botOptions = {
            host: serverAddress,
            port: parseInt(serverPort, 10),
            username: username,
            version: version || undefined, // Let backend handle default if empty
        };
        // Emit 'createBot' event with options
        sendMessage('createBot', botOptions);
        setUsername(''); // Clear username for next bot
    }, [serverAddress, serverPort, username, version, sendMessage]);

    // Memoized functions for bot actions
    const handleChangeActivity = useCallback((botId: string, activityName: string) => {
        sendMessage('changeActivity', { botId, activityName });
    }, [sendMessage]);

    const handleDeleteBot = useCallback((botId: string) => {
        if (confirm(`Are you sure you want to delete bot ${botId}?`)) {
            sendMessage('deleteBot', { botId });
        }
    }, [sendMessage]);

    // Functions for viewer modal
    const handleViewBot = useCallback((botId: string) => {
        console.log("Opening viewer for:", botId);
        setViewingBotId(botId);
    }, []);

    const handleCloseViewer = useCallback(() => {
        console.log("Closing viewer");
        setViewingBotId(null);
    }, []);

    return (
        <main style={{ padding: '20px', fontFamily: 'sans-serif' }}>
            <h1>Mineflayer Bot Manager</h1>

            <div className="controls" style={{ marginBottom: '20px', padding: '15px', border: '1px solid #ccc', borderRadius: '5px' }}>
                <h2>Create New Bot</h2>
                <div style={{ marginBottom: '10px' }}>
                    <label htmlFor="server-address" style={{ marginRight: '5px' }}>Server Address:</label>
                    <input
                        type="text"
                        id="server-address"
                        placeholder="e.g., localhost or IP"
                        value={serverAddress}
                        onChange={(e) => setServerAddress(e.target.value)}
                        style={{ marginRight: '10px', padding: '5px' }}
                    />
                </div>
                <div style={{ marginBottom: '10px' }}>
                    <label htmlFor="server-port" style={{ marginRight: '5px' }}>Port:</label>
                    <input
                        type="number"
                        id="server-port"
                        placeholder="e.g., 25565"
                        value={serverPort}
                        onChange={(e) => setServerPort(e.target.value)}
                        style={{ marginRight: '10px', padding: '5px' }}
                    />
                </div>
                <div style={{ marginBottom: '10px' }}>
                    <label htmlFor="username" style={{ marginRight: '5px' }}>Bot Username:</label>
                    <input
                        type="text"
                        id="username"
                        placeholder="e.g., Bot1"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        style={{ marginRight: '10px', padding: '5px' }}
                    />
                </div>
                <div style={{ marginBottom: '10px' }}>
                    <label htmlFor="version" style={{ marginRight: '5px' }}>Version (Optional):</label>
                    <input
                        type="text"
                        id="version"
                        placeholder="e.g., 1.20.1"
                        value={version}
                        onChange={(e) => setVersion(e.target.value)}
                        style={{ marginRight: '10px', padding: '5px' }}
                    />
                </div>
                <button id="create-bot-btn" onClick={handleCreateBot} style={{ padding: '8px 15px' }}>Create Bot</button>
            </div>

            <div className="bot-section">
                <h2>Active Bots</h2>
                <div id="bot-list">
                    {/* Display connection status */}
                    {connectionMessage && <p style={{ fontStyle: 'italic', color: error ? 'red' : (isConnected ? 'green' : '#555') }}>{connectionMessage}</p>}

                    {/* Render BotList only when connected */}
                    {isConnected ? (
                        <BotList
                            bots={bots}
                            availableActivities={availableActivities}
                            onChangeActivity={handleChangeActivity}
                            onDeleteBot={handleDeleteBot}
                            onViewBot={handleViewBot} // Pass the view handler
                            isConnected={isConnected} // Add back the isConnected prop
                        />
                    ) : (
                        !error && <p>Attempting to connect to the manager server...</p>
                    )}
                 </div>
            </div>

            {/* Render the viewer modal conditionally */}
            {viewingBotId && (
                <BotViewer botId={viewingBotId} onClose={handleCloseViewer} />
            )}
        </main>
    );
}
