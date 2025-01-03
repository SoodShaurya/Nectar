
function getNearest(bot, positions) {
    let nearest = null;
    let nearestDistance = Infinity;
    
    for (const pos of positions) {
        const distance = bot.entity.position.distanceTo(pos);
        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = pos;
        }
    }
    return nearest;
}

module.exports = getNearest;
