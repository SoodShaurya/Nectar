import { Entity } from "prismarine-entity";
// Import goals from the local pathfinder build output
import { goals } from "../../../pathfinder/dist/index.js";
import { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { FollowConfig, FullConfig } from "./swordconfigs";
// Removed duplicate Entity import

// Extend the correct GoalFollowEntity class
class PredictiveGoal extends goals.GoalFollowEntity {
  public readonly bot: Bot;
  public predictTicks: number;
  constructor(bot: Bot, entity: Entity, range: number, predictTicks: number) {
    // Call GoalFollowEntity constructor: super(entity.position, distance, opts)
    // Need to calculate distance from range. Assuming range is the desired distance.
    super(entity.position, range, { dynamic: true }); // Pass entity's position and range
    this.bot = bot;
    this.predictTicks = predictTicks;
    this.bot = bot; // Assign bot after super()
    this.predictTicks = predictTicks;
    this.bot.tracker.trackEntity(entity); // Track the entity
  }

  // Heuristic and isEnd are already defined in GoalFollowEntity,
  // but we might need to override or adjust them if the prediction logic differs.
  // Let's keep the existing heuristic for now.
  heuristic(node: { x: number; y: number; z: number }) {
    const dx = this.x - node.x; // x, y, z are inherited from GoalFollowEntity
    const dy = this.y - node.y;
    const dz = this.z - node.z;
    return this.distanceXZ(dx, dz) + Math.abs(dy); // Keep custom heuristic
  }

  // isEnd is defined in GoalFollowEntity, let's use that one.
  // isEnd(node: { x: number; y: number; z: number }) {
  //   const dx = this.x - node.x;
  //   const dy = this.y - node.y;
  //   const dz = this.z - node.z;
  //   return dx * dx + dy * dy + dz * dz <= this.sqDist; // Use sqDist from GoalFollowEntity
  // }


  // Override hasChanged to incorporate prediction logic
  // Use 'any' for the entity parameter type to bypass the incompatible Entity type error.
  hasChanged(event: 'entityMoved', e: any): boolean {
     // Only trigger update if the event is for the entity we are tracking
     // Use type assertion for e.position if needed, though direct comparison might work
     if (e.position !== this.refVec) return false;

     // Calculate predicted position
     const predictedPos = this.predictiveFunction(
       this.refVec.minus(this.bot.entity.position), // Use current refVec (entity actual pos)
       this.refVec,
       this.bot.tracker.getEntitySpeed(e) || new Vec3(0, 0, 0)
     );

     // Check if the predicted position is significantly different from the current goal position (this.x, this.y, this.z)
     const dx = this.x - predictedPos.x;
     const dy = this.y - predictedPos.y;
     const dz = this.z - predictedPos.z;

     // Use a threshold slightly larger than 1 block to avoid jitter
     const movedSignificantly = (dx * dx + dy * dy + dz * dz) > 1.5; // Example threshold

     if (movedSignificantly) {
        // Update the goal's target position (x, y, z) to the new predicted position
        this.x = predictedPos.x;
        this.y = predictedPos.y;
        this.z = predictedPos.z;
        // Also update the base refVec in the parent class to the entity's current actual position
        // This ensures the parent class's isValid check works correctly.
        super.update(); // Call parent update which sets x,y,z to refVec - we override this immediately after
        this.x = predictedPos.x; // Re-apply predicted position
        this.y = predictedPos.y;
        this.z = predictedPos.z;
        return true; // Indicate the goal has changed
     }

     // Also need to update the base refVec if the entity moved, even if prediction didn't change goal significantly
     // This keeps the parent class's state consistent.
     const baseMoved = super.hasChanged(event, e);
     if (baseMoved) {
        // If base moved but prediction didn't change goal, reset goal x,y,z to predicted based on new base
        const newPredictedPos = this.predictiveFunction(
            this.refVec.minus(this.bot.entity.position),
            this.refVec,
            this.bot.tracker.getEntitySpeed(e) || new Vec3(0, 0, 0)
        );
        this.x = newPredictedPos.x;
        this.y = newPredictedPos.y;
        this.z = newPredictedPos.z;
     }


     return movedSignificantly || baseMoved;
  }


  // Keep the predictive function
   public predictiveFunction(delta: Vec3, pos: Vec3, vel: Vec3) {
    const base = Math.round(Math.sqrt(delta.x ** 2 + delta.y ** 2 + delta.z ** 2));
    const tickCount = Math.round((base * this.predictTicks) / Math.sqrt(base));
    return pos.plus(vel.scaled(isNaN(tickCount) ? 0 : tickCount));
  }

  distanceXZ(dx: number, dz: number) {
    dx = Math.abs(dx);
    dz = Math.abs(dz);
    return Math.abs(dx - dz) + Math.min(dx, dz) * Math.SQRT2;
  }
}

export function followEntity(bot: Bot, entity: Entity, options: FullConfig) {
  switch (options.followConfig.mode) {
    case "jump":
      // const tmp1 = GoalFactory.predictEntity(
      //   bot,
      //   entity,
      //   options.followConfig.distance,
      //   options.followConfig.predict ? options.followConfig.predictTicks ?? 4 : 0
      // );
      // bot.jumpPather.goto(tmp1);
      // return tmp1;
    case "standard":
      const tmp2 = new PredictiveGoal(
        bot,
        entity,
        options.followConfig.distance,
        options.followConfig.predict ? options.followConfig.predictTicks ?? 4 : 0
      );
      // Use goto instead of setGoal, with type assertion for pathfinder
      (bot as any).pathfinder.goto(tmp2);
      return tmp2;
  }
}

export function stopFollow(bot: Bot, mode: FollowConfig["mode"]) {
  // bot.jumpPather.stop(); // Assuming jumpPather also needs cancel if used
  // Use cancel instead of stop, with type assertion for pathfinder
  (bot as any).pathfinder.cancel();
}
