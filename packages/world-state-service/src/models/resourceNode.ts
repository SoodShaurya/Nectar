import mongoose, { Schema, Document } from 'mongoose';
import { Coordinates } from '@aetherius/shared-types';

export interface IResourceNode extends Document {
  reporterAgentId: string;
  timestamp: Date;
  resourceType: string; // e.g., "minecraft:iron_ore", "minecraft:oak_log"
  coords: Coordinates; // Coord of first block found
  quantityEstimate?: string | number; // e.g., "Small", "Medium", "Large", "Single", or a number
  depleted: boolean;
}

const ResourceNodeSchema: Schema = new Schema({
  reporterAgentId: { type: String, required: true, index: true },
  timestamp: { type: Date, default: Date.now, index: true },
  resourceType: { type: String, required: true, index: true },
  coords: {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    z: { type: Number, required: true },
  },
  quantityEstimate: { type: Schema.Types.Mixed }, // Allow string or number
  depleted: { type: Boolean, default: false, index: true },
});

// Index for querying by resource type and depletion status
ResourceNodeSchema.index({ resourceType: 1, depleted: 1, timestamp: -1 });
// Geospatial index for finding nearby resources
ResourceNodeSchema.index({ coords: '2dsphere' });

// Optional TTL index
// ResourceNodeSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export default mongoose.model<IResourceNode>('ResourceNode', ResourceNodeSchema);