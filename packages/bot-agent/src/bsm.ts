import net from 'net';
import { EventEmitter } from 'events';
import { AgentEvent, AgentStatusSnapshot, TaskObject } from '@aetherius/shared-types';
import { createLogger, metrics } from '@aetherius/shared-types';
import { BehaviorAlert } from './behavior/alerts';

const logger = createLogger('bot-agent:bsm');

export class BSMClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private isRegistered = false;
  private messageBuffer = '';
  private agentId: string;
  private host: string;
  private port: number;

  constructor(agentId: string, host: string, port: number) {
    super();
    this.agentId = agentId;
    this.host = host;
    this.port = port;
  }

  get registered(): boolean {
    return this.isRegistered;
  }

  connect(): void {
    if (this.socket && !this.socket.destroyed) {
      logger.info('Already connected or connecting to BSM.');
      return;
    }

    this.socket = net.createConnection({ host: this.host, port: this.port }, () => {
      logger.info('Connected to BSM TCP server.');
      metrics.increment('bsm_connections');
      const registrationMessage = { type: 'register', payload: { agentId: this.agentId } };
      this.send(registrationMessage);
      this.isRegistered = true;
      this.emit('registered');
    });

    this.socket.on('data', (data: Buffer) => {
      this.messageBuffer += data.toString();
      let boundary = this.messageBuffer.indexOf('\n');
      while (boundary !== -1) {
        const messageString = this.messageBuffer.substring(0, boundary);
        this.messageBuffer = this.messageBuffer.substring(boundary + 1);
        try {
          const message = JSON.parse(messageString);
          if (message.type === 'command' && message.payload) {
            this.emit('command', message.payload.taskId, message.payload.task as TaskObject, message.payload.completionCondition);
          } else if (message.type === 'updateProfile' && message.payload) {
            this.emit('updateProfile', message.payload);
          } else if (message.type === 'cancelTask' && message.payload) {
            this.emit('cancelTask', message.payload.taskId);
          } else if (message.type === 'chatMessage' && message.payload) {
            this.emit('chatMessage', message.payload.message);
          } else {
            logger.warn(`Unknown BSM message type: ${message.type}`);
          }
        } catch (error) {
          logger.error('Failed to parse BSM message:', error);
        }
        boundary = this.messageBuffer.indexOf('\n');
      }
    });

    this.socket.on('end', () => {
      logger.info('Disconnected from BSM TCP server.');
      metrics.increment('bsm_disconnections');
      this.isRegistered = false;
      this.socket = null;
      logger.info('Attempting to reconnect to BSM in 5 seconds...');
      setTimeout(() => this.connect(), 5000);
    });

    this.socket.on('error', (err: Error) => {
      logger.error('BSM TCP connection error:', err.message);
      metrics.increment('bsm_connection_errors');
      this.isRegistered = false;
      this.socket?.destroy();
      this.socket = null;
      const delay = err.message.includes('ECONNREFUSED') ? 15000 : 5000;
      setTimeout(() => this.connect(), delay);
    });
  }

  send(message: any): boolean {
    if (this.socket && !this.socket.destroyed && this.isRegistered) {
      try {
        this.socket.write(JSON.stringify(message) + '\n');
        return true;
      } catch (error) {
        logger.error('Failed to send message to BSM:', error);
        return false;
      }
    }
    return false;
  }

  reportEvent(event: Omit<AgentEvent, 'agentId' | 'timestamp' | 'destination'>): void {
    const fullEvent: AgentEvent = {
      ...event,
      agentId: this.agentId,
      timestamp: new Date().toISOString(),
      destination: event.eventType === 'foundPOI' || event.eventType === 'foundResource'
        ? 'world_state_service'
        : 'commander',
    } as AgentEvent;

    metrics.increment('events_reported');
    metrics.increment(`event_${event.eventType}`);
    this.send(fullEvent);
  }

  reportBehaviorAlert(alert: BehaviorAlert): void {
    this.reportEvent({
      eventType: 'behaviorAlert' as any,
      details: alert as any,
    });
  }

  reportStatusUpdate(snapshot: AgentStatusSnapshot): void {
    const message = {
      ...snapshot,
      agentId: this.agentId,
      timestamp: new Date().toISOString(),
      destination: 'commander',
    };
    this.send(message);
  }

  destroy(): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
    }
  }
}
