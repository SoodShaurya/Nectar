'use client';

import React, { useState, useCallback, useEffect } from 'react';

// Define types matching page.tsx and BotList.tsx
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

interface BotItemProps {
    bot: Bot;
    availableActivities: string[];
    onChangeActivity: (botId: string, activityName: string) => void;
    onDeleteBot: (botId: string) => void;
    onViewBot: (botId: string) => void;
    onSetTargetCoordinates: (botId: string, coords: { x: number; y: number; z: number }) => void;
    // --- Refactored Combat Props ---
    onGetNearbyEntities: (botId: string) => void;
    onSetCombatTarget: (botId: string, targetId: string | number) => void; // New prop
    // onStartCombat and onStopCombat removed
    nearbyEntities: EntityInfo[] | null; // Entities specific to this bot, passed from parent
    // --- End Refactored Combat Props ---
    isDisabled: boolean; // Controls whether inputs/buttons are disabled
}

const BotItem: React.FC<BotItemProps> = ({
    bot,
    availableActivities,
    onChangeActivity,
    onDeleteBot,
    onViewBot,
    onSetTargetCoordinates,
    // --- Destructure Refactored Combat Props ---
    onGetNearbyEntities,
    onSetCombatTarget, // Destructure new prop
    // onStartCombat and onStopCombat removed
    nearbyEntities,
    // --- End Destructure ---
    isDisabled,
}) => {
    // State for activity dropdown
    const [selectedActivity, setSelectedActivity] = useState(bot.activity || '');
    // State for coordinate inputs
    const [targetX, setTargetX] = useState('');
    const [targetY, setTargetY] = useState('');
    const [targetZ, setTargetZ] = useState('');
    // --- New Combat State ---
    const [selectedTargetId, setSelectedTargetId] = useState<string | number>(''); // Can be username or entity ID
    // --- End New Combat State ---


    // Update local activity state if the bot's activity prop changes from the server
    useEffect(() => {
        setSelectedActivity(bot.activity || '');
    }, [bot.activity]);

    // Clear selected target if the entity list changes (e.g., after refresh)
    useEffect(() => {
        setSelectedTargetId('');
    }, [nearbyEntities]);

    const handleActivityChangeClick = useCallback(() => {
        onChangeActivity(bot.id, selectedActivity);
    }, [bot.id, selectedActivity, onChangeActivity]);

    const handleSetTargetClick = useCallback(() => {
        const x = parseFloat(targetX);
        const y = parseFloat(targetY);
        const z = parseFloat(targetZ);
        if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
            onSetTargetCoordinates(bot.id, { x, y, z });
            // Optionally clear fields after setting
            // setTargetX('');
            // setTargetY('');
            // setTargetZ('');
        } else {
            alert('Please enter valid numbers for X, Y, and Z coordinates.');
        }
    }, [bot.id, targetX, targetY, targetZ, onSetTargetCoordinates]);

    const handleDeleteClick = useCallback(() => {
        onDeleteBot(bot.id);
    }, [bot.id, onDeleteBot]);

    const handleViewClick = useCallback(() => {
        onViewBot(bot.id);
    }, [bot.id, onViewBot]);

    // --- New Combat Handlers ---
    const handleFindTargetsClick = useCallback(() => {
        onGetNearbyEntities(bot.id);
    }, [bot.id, onGetNearbyEntities]);

    // handleAttackClick and handleStopCombatClick removed

    // --- New Handler for Setting Combat Target ---
     const handleSetCombatTargetClick = useCallback(() => {
        if (selectedTargetId) {
            onSetCombatTarget(bot.id, selectedTargetId);
            alert(`Combat target set to ${selectedTargetId} for ${bot.id}. Change activity to 'combat' to start.`); // User feedback
        } else {
            alert('Please select a target first.');
        }
    }, [bot.id, selectedTargetId, onSetCombatTarget]);
    // --- End New Handler ---


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

            {/* Bot Controls Area */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {/* Activity Controls */}
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
                    {/* Delete button moved here */}
                    <button
                        onClick={handleDeleteClick}
                        style={{ padding: '5px 10px', backgroundColor: '#f44336', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer' }}
                    >
                        Delete
                    </button>
                    {/* View Button moved here */}
                     <button
                        onClick={handleViewClick}
                        disabled={isDisabled} // Disable if bot is not idle
                        style={{ padding: '5px 10px', backgroundColor: '#2196F3', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer' }}
                    >
                        View
                    </button>
                </div>

                {/* Target Coordinates Controls */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <label>Target Coords:</label>
                    <input
                        type="number"
                        placeholder="X"
                        value={targetX}
                        onChange={(e) => setTargetX(e.target.value)}
                        disabled={isDisabled}
                        style={{ width: '60px', padding: '5px' }}
                    />
                    <input
                        type="number"
                        placeholder="Y"
                        value={targetY}
                        onChange={(e) => setTargetY(e.target.value)}
                        disabled={isDisabled}
                        style={{ width: '60px', padding: '5px' }}
                    />
                    <input
                        type="number"
                        placeholder="Z"
                        value={targetZ}
                        onChange={(e) => setTargetZ(e.target.value)}
                        disabled={isDisabled}
                        style={{ width: '60px', padding: '5px' }}
                    />
                    <button
                        onClick={handleSetTargetClick}
                        disabled={isDisabled || !targetX || !targetY || !targetZ}
                        style={{ padding: '5px 10px' }}
                    >
                        Set Target
                    </button>
                </div>

                 {/* Combat Target Controls */}
                 <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <label>Combat Target:</label>
                    <button
                        onClick={handleFindTargetsClick}
                        disabled={isDisabled}
                        style={{ padding: '5px 10px' }}
                        title="Refresh nearby entity list"
                    >
                        Find Targets
                    </button>
                    <select
                        value={selectedTargetId}
                        onChange={(e) => setSelectedTargetId(e.target.value)}
                        disabled={isDisabled || !nearbyEntities || nearbyEntities.length === 0}
                        style={{ padding: '5px', minWidth: '150px' }}
                    >
                        <option value="" disabled>Select Target...</option>
                        {nearbyEntities?.map((entity) => (
                            <option key={entity.id} value={entity.username || entity.id}> {/* Use username if available, else ID */}
                                {entity.username || entity.name || `ID: ${entity.id}`} ({entity.type})
                            </option>
                        ))}
                    </select>
                     {/* "Set Combat Target" button moved here */}
                     <button
                        onClick={handleSetCombatTargetClick} // Use the correct handler
                        disabled={isDisabled || !selectedTargetId} // Disable only if no target selected or bot busy
                        style={{ padding: '5px 10px', backgroundColor: '#ff9800', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer' }}
                    >
                        Set Combat Target
                    </button>
                    {/* Attack and Stop Combat buttons removed */}
                </div>

            </div>
        </div>
    );
};

export default BotItem;
