import { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

// Define Bot type (consistent with components)
export interface Bot {
    id: string;
    status: string;
    activity?: string; // Changed from string | null to optional string
    options: any;
}

// Define the hook's return structure
interface SocketHook {
    bots: Bot[];
    activities: string[];
    isConnected: boolean;
    sendMessage: (eventName: string, payload: any) => void;
    error: string | null;
    connect: () => void;
    disconnect: () => void;
}

// Hook implementation using Socket.IO
export function useWebSocket(url: string | null): SocketHook {
    const [bots, setBots] = useState<Bot[]>([]);
    const [activities, setActivities] = useState<string[]>([]);
    const [isConnected, setIsConnected] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    const socketRef = useRef<Socket | null>(null);

    const disconnect = useCallback(() => {
        if (socketRef.current) {
            console.log('Disconnecting Socket.IO socket...');
            socketRef.current.disconnect();
            socketRef.current = null; // Clear the ref after disconnect
            setIsConnected(false);
            setBots([]); // Clear state on disconnect
            setActivities([]);
            setError(null);
        }
    }, []);

    const connect = useCallback(() => {
        if (!url || (socketRef.current && socketRef.current.connected)) {
            console.log('Socket.IO already connected or URL is null.');
            return;
        }

        // Disconnect previous socket if exists
        if (socketRef.current) {
            disconnect();
        }

        console.log(`Attempting Socket.IO connection to ${url}...`);
        // Connect to the default namespace
        const socket = io(url, {
            reconnection: true,
            reconnectionAttempts: 5, // Or use options passed to the hook
            reconnectionDelay: 3000,
            path: '/socket.io', // Ensure this matches server if needed
        });
        socketRef.current = socket;
        setError(null);

        socket.on('connect', () => {
            console.log('Socket.IO Connected:', socket.id);
            setIsConnected(true);
            setError(null);
            // Request initial state after connection
            socket.emit('getBotList');
            socket.emit('getActivities');
        });

        socket.on('disconnect', (reason) => {
            console.log('Socket.IO Disconnected:', reason);
            setIsConnected(false);
            // Handle potential cleanup or state reset if needed
            if (reason === 'io server disconnect') {
                // The server forced the disconnect, maybe try to reconnect manually
                // socket.connect(); // Be careful with automatic reconnect loops
            }
            // else the client will automatically try to reconnect based on options
        });

        socket.on('connect_error', (err) => {
            console.error('Socket.IO Connection Error:', err.message);
            setError(`Connection Error: ${err.message}`);
            setIsConnected(false); // Ensure disconnected state
            // socketRef.current = null; // Socket.IO handles the ref internally on error? Check docs.
        });

        // --- Listen for specific events from the server ---
        socket.on('botListUpdate', (payload: Bot[]) => {
            console.log('Received botListUpdate:', payload);
            setBots(payload || []);
        });

        socket.on('availableActivities', (payload: string[]) => {
            console.log('Received availableActivities:', payload);
            setActivities(payload || []);
        });

        socket.on('error', (errorMessage: string) => { // Listen for custom 'error' events
             console.error('Server error message:', errorMessage);
             setError(`Server Error: ${errorMessage}`);
        });

        // Add listeners for any other events from the default namespace here

    }, [url, disconnect]);

    useEffect(() => {
        if (url) {
            connect();
        } else {
            disconnect();
        }

        // Cleanup function
        return () => {
            disconnect();
        };
    }, [url, connect, disconnect]);

    // Function to send messages (emit events) to the server
    const sendMessage = useCallback((eventName: string, payload: any = {}) => {
        if (socketRef.current && socketRef.current.connected) {
            console.log(`Emitting event "${eventName}":`, payload);
            socketRef.current.emit(eventName, payload);
        } else {
            console.error('Socket.IO is not connected. Cannot send message.');
            setError('Not connected to server. Cannot perform action.');
        }
    }, []); // Depends only on the socketRef state

    return {
        bots,
        activities,
        isConnected,
        error,
        sendMessage,
        connect,
        disconnect,
    };
}
