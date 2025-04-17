import { useState, useEffect, useRef, useCallback } from 'react';

interface WebSocketHookOptions {
    reconnectInterval?: number; // Milliseconds between reconnect attempts
    maxReconnectAttempts?: number; // Maximum number of reconnect attempts (-1 for infinite)
}

interface WebSocketMessage {
    type: string;
    payload?: any;
}

const DEFAULT_RECONNECT_INTERVAL = 5000; // 5 seconds
const DEFAULT_MAX_RECONNECT_ATTEMPTS = -1; // Infinite

export function useWebSocket(url: string | null, options: WebSocketHookOptions = {}) {
    const {
        reconnectInterval = DEFAULT_RECONNECT_INTERVAL,
        maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
    } = options;

    const [isConnected, setIsConnected] = useState(false);
    const [lastMessage, setLastMessage] = useState<MessageEvent | null>(null);
    const [error, setError] = useState<Event | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const reconnectAttemptsRef = useRef(0);
    const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);

    const connect = useCallback(() => {
        if (!url || (socketRef.current && socketRef.current.readyState === WebSocket.OPEN)) {
            console.log('WebSocket already connected or URL is null.');
            return;
        }

        // Clear any existing reconnect timer
        if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
        }

        console.log(`Attempting WebSocket connection to ${url}...`);
        socketRef.current = new WebSocket(url);

        socketRef.current.onopen = () => {
            console.log('WebSocket connection established.');
            setIsConnected(true);
            setError(null);
            reconnectAttemptsRef.current = 0; // Reset reconnect attempts on successful connection
        };

        socketRef.current.onmessage = (event) => {
            // console.log('WebSocket message received:', event.data);
            setLastMessage(event);
        };

        socketRef.current.onerror = (event) => {
            console.error('WebSocket error:', event);
            setError(event);
            // Note: onclose will usually be called after onerror
        };

        socketRef.current.onclose = (event) => {
            console.log('WebSocket connection closed:', event.code, event.reason || 'No reason specified');
            setIsConnected(false);
            setLastMessage(null); // Clear last message on disconnect
            socketRef.current = null; // Ensure ref is nullified

            // Attempt to reconnect if conditions are met
            if (maxReconnectAttempts === -1 || reconnectAttemptsRef.current < maxReconnectAttempts) {
                reconnectAttemptsRef.current++;
                console.log(`Attempting to reconnect (${reconnectAttemptsRef.current}/${maxReconnectAttempts === -1 ? '∞' : maxReconnectAttempts})...`);
                reconnectTimerRef.current = setTimeout(connect, reconnectInterval);
            } else {
                console.log('Maximum reconnect attempts reached.');
                setError(new Event('Maximum reconnect attempts reached.')); // Set an error state
            }
        };
    }, [url, reconnectInterval, maxReconnectAttempts]);

    const disconnect = useCallback(() => {
        if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
        }
        if (socketRef.current) {
            console.log('Closing WebSocket connection manually.');
            socketRef.current.close();
            socketRef.current = null;
            setIsConnected(false);
            setLastMessage(null);
            reconnectAttemptsRef.current = 0; // Reset attempts on manual disconnect
        }
    }, []);

    useEffect(() => {
        if (url) {
            connect();
        } else {
            // If URL becomes null, disconnect cleanly
            disconnect();
        }

        // Cleanup function: close connection when component unmounts or URL changes
        return () => {
            disconnect();
        };
    }, [url, connect, disconnect]); // Re-run effect if URL or connect/disconnect functions change

    const sendMessage = useCallback((type: string, payload: any = {}) => {
        if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
            const message: WebSocketMessage = { type, payload };
            const messageString = JSON.stringify(message);
            console.log('Sending message:', messageString);
            socketRef.current.send(messageString);
        } else {
            console.error('WebSocket is not connected. Cannot send message.');
            // Optionally, queue the message or throw an error
        }
    }, []); // Depends only on the socketRef state

    return {
        isConnected,
        lastMessage,
        error,
        sendMessage,
        connect, // Expose connect/disconnect if manual control is needed
        disconnect,
    };
}
