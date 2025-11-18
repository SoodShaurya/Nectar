import mongoose, { Schema, Document } from 'mongoose';
import { Coordinates } from '@aetherius/shared-types'; // Assuming Coordinates is defined in shared-types

// Interface matching the schema structure (optional but good practice)
export interface IPOI extends Document {
  reporterAgentId: string;
  timestamp: Date;
  type: string; // e.g., "CaveEntrance", "VillageChurch", "Spawner", "EndPortalFrame"
  name?: string; // Optional user-friendly name
  coords: Coordinates;
  biome?: string; // Optional
  details?: object; // Type-specific info
}

const POISchema: Schema = new Schema({
  reporterAgentId: { type: String, required: true, index: true },
  timestamp: { type: Date, default: Date.now, index: true },
  type: { type: String, required: true, index: true },
  name: { type: String },
  coords: {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    z: { type: Number, required: true },
  },
  biome: { type: String },
  details: { type: Schema.Types.Mixed }, // For flexible type-specific info
});

// Create a geospatial index on coordinates for efficient proximity queries
POISchema.index({ coords: '2dsphere' }); // If using MongoDB geospatial features
// Or a compound index for manual proximity checks
// POISchema.index({ 'coords.x': 1, 'coords.z': 1, 'coords.y': 1 });

// Add TTL index if desired for automatic cleanup of old data (e.g., expire after 30 days)
// POISchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export default mongoose.model<IPOI>('POI', POISchema);