'use client'; // Required for hooks like useState, useEffect

'use client'; // Required for hooks like useState, useEffect

import React, { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket'; // Import the hook
// We will create these components later
import BotList from '@/components/BotList'; // Uncommented import

// Define types for clarity (optional but good practice)
interface Bot {
    id: string;
    status: string;
    activity?: string;
    // Add other relevant bot properties if needed
}

export default function Home() {
    // State for form inputs
    const [serverAddress, setServerAddress] = useState('');
    const [serverPort, setServerPort] = useState('25565');
    const [username, setUsername] = useState('');
    const [version, setVersion] = useState('');

    // State for application data
    const [bots, setBots] = useState<Bot[]>([]);
    const [availableActivities, setAvailableActivities] = useState<string[]>([]);
    // Removed local isConnected state: const [isConnected, setIsConnected] = useState(false);
    const [connectionMessage, setConnectionMessage] = useState('Determining WebSocket URL...');
    const [wsUrl, setWsUrl] = useState<string | null>(null);

    // Determine WebSocket URL on client-side mount
    useEffect(() => {
        // This code runs only in the browser
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        // Use hostname and the new fixed port 6900
        const url = `${protocol}//${window.location.hostname}:6900`;
        console.log(`WebSocket URL determined: ${url}`);
        setWsUrl(url);
        setConnectionMessage('Connecting to server...'); // Update status message
    }, []); // Empty dependency array ensures this runs only once on mount

    // Initialize WebSocket connection using the hook
    const { sendMessage, lastMessage, isConnected, error } = useWebSocket(wsUrl); // Pass the dynamic URL

    // Update connection message based on hook state
    useEffect(() => {
        if (error) {
            // Extract a meaningful message from the error event if possible
            let errorMsg = 'WebSocket error occurred.';
            if (error instanceof Event && 'message' in error) {
                 errorMsg = (error as any).message || errorMsg;
            } else if (typeof error === 'string') {
                 errorMsg = error;
            }
             // Check if it's the max reconnect attempts error
            if (error.type === 'error' && (error as any).message === 'Maximum reconnect attempts reached.') {
                errorMsg = 'Connection failed after multiple attempts. Please check the server.';
            }

            setConnectionMessage(`Error: ${errorMsg}`);
        } else if (isConnected) {
            setConnectionMessage('Connected.');
            // Clear the message after a short delay or when data arrives
            const timer = setTimeout(() => setConnectionMessage(''), 2000);
            return () => clearTimeout(timer);
        } else if (wsUrl) {
             // Only show connecting message if URL is set and not yet connected/errored
            setConnectionMessage('Connecting...');
        }
    }, [isConnected, error, wsUrl]);


    // Memoize handleServerMessage to avoid re-creating it on every render
    const handleServerMessage = useCallback((message: any) => {
        const { type, payload } = message;
        switch (type) {
            case 'botListUpdate':
                setBots(payload);
                setConnectionMessage(''); // Clear connection message once list is received
                break;
            case 'availableActivities':
                setAvailableActivities(payload);
                // Note: Re-rendering BotList will happen automatically if 'bots' state changes,
                // or if BotList/BotItem uses availableActivities directly.
                break;
            case 'error':
                alert(`Server Error: ${payload}`); // Simple error display
                setConnectionMessage(`Server Error: ${payload}`);
                break;
            default:
                console.log('Unknown message type received:', type);
        }
    }, [setBots, setAvailableActivities]); // Dependencies for the callback

     // Effect to process incoming messages
     useEffect(() => {
        if (lastMessage) {
            console.log('Raw message from server:', lastMessage.data);
            try {
                // Ensure lastMessage.data is a string before parsing
                if (typeof lastMessage.data === 'string') {
                    const message = JSON.parse(lastMessage.data);
                    handleServerMessage(message);
                } else {
                     console.error('Received non-string message data:', lastMessage.data);
                     setConnectionMessage('Received unexpected data format from server.');
                }
            } catch (err) {
                console.error('Failed to parse server message:', err);
                // Check if the error is a SyntaxError (likely JSON parse failure)
                if (err instanceof SyntaxError) {
                    setConnectionMessage('Received invalid message format from server.');
                } else {
                    setConnectionMessage('Error processing server message.');
                }
            }
        }
    }, [lastMessage, handleServerMessage]); // Re-run when lastMessage or the handler changes


    const handleCreateBot = useCallback(() => {
        if (!serverAddress || !serverPort || !username) {
            alert('Please fill in Server Address, Port, and Bot Username.');
            return;
        }
        const botData = {
            host: serverAddress,
            port: parseInt(serverPort, 10),
            username: username,
            version: version || undefined, // Send undefined if empty
        };
        sendMessage('createBot', botData); // Use sendMessage from hook
        setUsername(''); // Clear username for next bot
    }, [serverAddress, serverPort, username, version, sendMessage]); // Dependencies

    // Memoized functions for bot actions (to be passed to BotItem)
    const handleChangeActivity = useCallback((botId: string, activityName: string) => {
        sendMessage('changeActivity', { botId, activityName }); // Use sendMessage
    }, [sendMessage]); // Dependency

    const handleDeleteBot = useCallback((botId: string) => {
        if (confirm(`Are you sure you want to delete bot ${botId}?`)) {
            sendMessage('deleteBot', { botId }); // Use sendMessage
        }
    }, [sendMessage]); // Dependency


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
                        placeholder="e.g., localhost"
                        value={serverAddress}
                        onChange={(e) => setServerAddress(e.target.value)}
                        style={{ marginRight: '10px' }}
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
                        style={{ marginRight: '10px' }}
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
                        style={{ marginRight: '10px' }}
                    />
                </div>
                <div style={{ marginBottom: '10px' }}>
                    <label htmlFor="version" style={{ marginRight: '5px' }}>Version (Optional):</label>
                    <input
                        type="text"
                        id="version"
                        placeholder="e.g., 1.19.4"
                        value={version}
                        onChange={(e) => setVersion(e.target.value)}
                        style={{ marginRight: '10px' }}
                    />
                </div>
                <button id="create-bot-btn" onClick={handleCreateBot}>Create Bot</button>
            </div>

            <div className="bot-section">
                <h2>Active Bots</h2>
                <div id="bot-list">
                    {/* Display connection status prominently */}
                    {connectionMessage && connectionMessage !== 'Connected.' && <p style={{ fontStyle: 'italic', color: error ? 'red' : '#555' }}>{connectionMessage}</p>}

                    {/* Display connection status prominently */}
                    {connectionMessage && connectionMessage !== 'Connected.' && <p style={{ fontStyle: 'italic', color: error ? 'red' : '#555' }}>{connectionMessage}</p>}

                    {/* Use the actual BotList component */}
                    {isConnected && (
                        <BotList
                            bots={bots}
                            availableActivities={availableActivities}
                            onChangeActivity={handleChangeActivity}
                            onDeleteBot={handleDeleteBot}
                            isConnected={isConnected} // Pass connection status
                        />
                    )}
                    {/* Removed temporary rendering logic */}
                    {!isConnected && !error && <p>Attempting to connect...</p>}
                 </div>
            </div>
        </main>
    );
}
