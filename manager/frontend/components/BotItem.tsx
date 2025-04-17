'use client';

import React, { useState, useCallback } from 'react';

// Define types matching page.tsx and BotList.tsx
interface Bot {
    id: string;
    status: string;
    activity?: string;
}

interface BotItemProps {
    bot: Bot;
    availableActivities: string[];
    onChangeActivity: (botId: string, activityName: string) => void;
    onDeleteBot: (botId: string) => void;
    onViewBot: (botId: string) => void; // Add the view handler prop
    isDisabled: boolean; // Controls whether inputs/buttons are disabled
}

const BotItem: React.FC<BotItemProps> = ({
    bot,
    availableActivities,
    onChangeActivity,
    onDeleteBot,
    onViewBot, // Destructure the view handler
    isDisabled,
}) => {
    // State to manage the selected activity in the dropdown for this specific bot item
    const [selectedActivity, setSelectedActivity] = useState(bot.activity || '');

    // Update local state if the bot's activity prop changes from the server
    React.useEffect(() => {
        setSelectedActivity(bot.activity || '');
    }, [bot.activity]);

    const handleActivityChangeClick = useCallback(() => {
        onChangeActivity(bot.id, selectedActivity);
    }, [bot.id, selectedActivity, onChangeActivity]);

    const handleDeleteClick = useCallback(() => {
        onDeleteBot(bot.id);
    }, [bot.id, onDeleteBot]);

    const handleViewClick = useCallback(() => {
        onViewBot(bot.id);
    }, [bot.id, onViewBot]);

    return (
        <div
            style={{
                border: '1px solid #eee',
                padding: '10px',
                marginBottom: '10px',
                borderRadius: '4px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                opacity: isDisabled ? 0.6 : 1, // Visual cue for disabled state
            }}
            data-bot-id={bot.id}
        >
            {/* Bot Info */}
            <div>
                <strong>{bot.id}</strong><br />
                <span className="bot-status">Status: {bot.status}</span><br />
                <span className="bot-activity">Activity: {bot.activity || 'N/A'}</span>
            </div>

            {/* Bot Controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <select
                    value={selectedActivity}
                    onChange={(e) => setSelectedActivity(e.target.value)}
                    disabled={isDisabled} // Disable based on prop
                    style={{ padding: '5px' }}
                >
                    {/* Add a default/placeholder option if needed */}
                    {/* <option value="" disabled={!bot.activity}>Select Activity...</option> */}
                    {availableActivities.map((actName) => (
                        <option key={actName} value={actName}>
                            {actName}
                        </option>
                    ))}
                </select>
                <button
                    onClick={handleActivityChangeClick}
                    disabled={isDisabled || !selectedActivity} // Also disable if no activity selected
                    style={{ padding: '5px 10px' }}
                >
                    Change Activity
                </button>
                <button
                    onClick={handleDeleteClick}
                    // Optionally keep delete enabled even if bot is busy? User decision.
                    // disabled={isDisabled}
                    style={{ padding: '5px 10px', backgroundColor: '#f44336', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer' }}
                >
                    Delete
                </button>
                {/* Add View Button */}
                <button
                    onClick={handleViewClick}
                    disabled={isDisabled} // Disable if bot is not idle
                    style={{ padding: '5px 10px', backgroundColor: '#2196F3', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer' }}
                >
                    View
                </button>
            </div>
        </div>
    );
};

export default BotItem;
