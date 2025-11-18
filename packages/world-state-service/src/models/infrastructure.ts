import mongoose, { Schema, Document } from 'mongoose';
import { Coordinates } from '@aetherius/shared-types';

export interface IInfrastructure extends Document {
  reporterAgentId: string;
  timestamp: Date;
  type: string; // e.g., "Base", "Farm", "StorageDepot", "Bridge"
  name: string; // User-defined or generated name
  coords: Coordinates; // Anchor point or center
  features?: string[]; // List of features (e.g., "Crafting Table", "Furnace", "Bed")
  // Add other relevant fields like dimensions, materials used, etc. if needed
}

const InfrastructureSchema: Schema = new Schema({
  reporterAgentId: { type: String, required: true, index: true },
  timestamp: { type: Date, default: Date.now, index: true },
  type: { type: String, required: true, index: true },
  name: { type: String, required: true },
  coords: {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    z: { type: Number, required: true },
  },
  features: [{ type: String }], // Array of strings
});

// Index for querying by type
InfrastructureSchema.index({ type: 1, timestamp: -1 });
// Geospatial index
InfrastructureSchema.index({ coords: '2dsphere' });

// Optional TTL index
// InfrastructureSchema.index({ timestamp: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 }); // e.g., 60 days

export default mongoose.model<IInfrastructure>('Infrastructure', InfrastructureSchema);