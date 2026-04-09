import mongoose, { Schema, Document } from 'mongoose';

export interface IGoal extends Document {
  goalId: string;
  type: 'acquisition' | 'persistent' | 'construction' | 'exploration' | 'social' | 'composite';
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: 'active' | 'paused' | 'completed' | 'failed';
  assignedAgents: string[];
  state: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  parentGoal?: string;
}

const GoalSchema: Schema = new Schema({
  goalId: { type: String, required: true, unique: true, index: true },
  type: {
    type: String,
    required: true,
    enum: ['acquisition', 'persistent', 'construction', 'exploration', 'social', 'composite'],
  },
  description: { type: String, required: true },
  priority: {
    type: String,
    required: true,
    enum: ['critical', 'high', 'medium', 'low'],
    default: 'medium',
  },
  status: {
    type: String,
    required: true,
    enum: ['active', 'paused', 'completed', 'failed'],
    default: 'active',
  },
  assignedAgents: { type: [String], default: [] },
  state: { type: Schema.Types.Mixed, default: {} },
  parentGoal: { type: String, index: true },
}, {
  timestamps: true, // Adds createdAt and updatedAt automatically
});

GoalSchema.index({ status: 1 });
GoalSchema.index({ priority: 1 });

export default mongoose.model<IGoal>('Goal', GoalSchema);
