'use client';

import React from 'react';
import BotItem from './BotItem'; // We'll create this next

// Define types matching page.tsx
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
    onViewBot: (botId: string) => void; // Add the new prop for viewing
    isConnected: boolean; // To determine overall state
}

const BotList: React.FC<BotListProps> = ({
    bots,
    availableActivities,
    onChangeActivity,
    onDeleteBot,
    onViewBot, // Destructure the new prop
    isConnected,
}) => {
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
                    onViewBot={onViewBot} // Pass the handler down
                    // Disable controls if bot is not idle or disconnected
                    isDisabled={bot.status !== 'idle'} // isConnected check is already done above
                />
            ))}
        </div>
    );
};

export default BotList;
