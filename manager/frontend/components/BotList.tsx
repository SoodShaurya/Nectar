    'use client';

import React, { useState } from 'react'; // Import useState
import BotItem from './BotItem'; // We'll create this next

// Define types matching page.tsx
interface EntityInfo {
    id: number | string; // Can be number (entity id) or string (username)
    username?: string;
    name?: string;
    type?: string;
    position?: { x: number; y: number; z: number };
}

interface Bot {
    id: string;
    status: string;
    activity?: string;
}

interface BotListProps {
    bots: Bot[];
    availableActivities: string[];
    onChangeActivity: (botId: string, activityName: string) => void;
    onDeleteBot: (botId: string) => void;
    onViewBot: (botId: string) => void;
    onSetTargetCoordinates: (botId: string, coords: { x: number; y: number; z: number }) => void;
    // --- Add Combat Props ---
    onGetNearbyEntities: (botId: string) => void;
    // onStartCombat and onStopCombat removed
    onSetCombatTarget: (botId: string, targetId: string | number) => void; // Added prop
    nearbyEntitiesMap: { [botId: string]: EntityInfo[] | null }; // Expect map from parent
    // --- End Combat Props ---
    isConnected: boolean; // To determine overall state
}

const BotList: React.FC<BotListProps> = ({
    bots,
    availableActivities,
    onChangeActivity,
    onDeleteBot,
    onViewBot,
    onSetTargetCoordinates,
    // --- Destructure Combat Props ---
    onGetNearbyEntities,
    // onStartCombat and onStopCombat removed
    onSetCombatTarget, // Destructure new prop
    nearbyEntitiesMap, // Destructure map from props
    // --- End Destructure ---
    isConnected,
}) => {
    // State for nearby entities is now managed by the parent (page.tsx)

    // Don't render the list component itself if not connected
    if (!isConnected) {
        return null; // Or a specific message if preferred
    }

    if (bots.length === 0) {
        return <p>No active bots.</p>;
    }

    return (
        <div>
            {bots.map((bot) => (
                <BotItem
                    key={bot.id}
                    bot={bot}
                    availableActivities={availableActivities}
                    onChangeActivity={onChangeActivity}
                    onDeleteBot={onDeleteBot}
                    onViewBot={onViewBot}
                    onSetTargetCoordinates={onSetTargetCoordinates} // Pass the handler down
                    // --- Pass Combat Props Down ---
                    onGetNearbyEntities={onGetNearbyEntities}
                    onSetCombatTarget={onSetCombatTarget} // Pass new handler down
                    // onStartCombat and onStopCombat removed
                    nearbyEntities={nearbyEntitiesMap[bot.id] || null} // Pass entities for this specific bot
                    // --- End Pass Combat Props ---
                    // Disable controls if bot is not idle or disconnected
                    isDisabled={bot.status !== 'idle'} // isConnected check is already done above
                />
            ))}
        </div>
    );
};

export default BotList;
