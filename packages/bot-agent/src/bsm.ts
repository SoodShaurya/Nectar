import net from 'net';
import { EventEmitter } from 'events';
import { AgentEvent, AgentStatusSnapshot, TaskObject } from '@aetherius/shared-types';
import { createLogger, metrics, TcpMsgType, parseTcpMessage } from '@aetherius/shared-types';
import { BehaviorAlert } from './behavior/alerts';

const logger = createLogger('bot-agent:bsm');

export interface BSMClientOptions {
  /** Optional shared secret presented to the BSM on TCP registration (design [D]). */
  authToken?: string;
}

export class BSMClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private isRegistered = false;
  private messageBuffer = '';
  private agentId: string;
  private host: string;
  private port: number;
  private authToken?: string;

  constructor(agentId: string, host: string, port: number, options: BSMClientOptions = {}) {
    super();
    this.agentId = agentId;
    this.host = host;
    this.port = port;
    this.authToken = options.authToken;
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
      this.isRegistered = true;
      const registrationMessage = {
        type: TcpMsgType.Register,
        payload: { agentId: this.agentId, authToken: this.authToken },
      };
      this.send(registrationMessage);
      this.emit('registered');
    });

    this.socket.on('data', (data: Buffer) => {
      this.messageBuffer += data.toString();
      let boundary = this.messageBuffer.indexOf('\n');
      while (boundary !== -1) {
        const messageString = this.messageBuffer.substring(0, boundary);
        this.messageBuffer = this.messageBuffer.substring(boundary + 1);
        boundary = this.messageBuffer.indexOf('\n'); // Pre-advance so `continue` is safe.

        // --- Boundary validation (design [E]) ---
        const parsed = parseTcpMessage(messageString);
        if (!parsed.ok) {
          logger.warn(`Dropping invalid TCP frame from BSM: ${parsed.error}`);
          metrics.increment('bsm_invalid_messages');
          continue;
        }
        const message = parsed.value;
        const payload = (message.payload ?? {}) as Record<string, any>;

        switch (message.type) {
          case TcpMsgType.Command:
            if (message.payload) {
              this.emit('command', payload.taskId, payload.task as TaskObject, payload.completionCondition);
            }
            break;
          case TcpMsgType.UpdateProfile:
            if (message.payload) this.emit('updateProfile', payload);
            break;
          case TcpMsgType.CancelTask:
            if (message.payload) this.emit('cancelTask', payload.taskId);
            break;
          case TcpMsgType.ChatMessage:
            if (message.payload) this.emit('chatMessage', payload.message);
            break;
          case TcpMsgType.RegisterAck:
            logger.info('Received registration ack from BSM.');
            break;
          default:
            logger.warn(`Unknown BSM message type: ${message.type}`);
        }
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
    this.send({ type: TcpMsgType.Event, payload: fullEvent });
  }

  /**
   * Immediately acknowledge a received command (design [A] step 3). Sent BEFORE
   * the task begins executing so the coordinator can transition the agent out of
   * its 'pending' state (accepted -> 'busy', rejected -> 'idle' + replan).
   */
  sendCommandAck(taskId: string, accepted: boolean, reason?: string): void {
    const payload: { agentId: string; taskId: string; accepted: boolean; reason?: string } = {
      agentId: this.agentId,
      taskId,
      accepted,
    };
    if (reason !== undefined) payload.reason = reason;
    metrics.increment('command_acks_sent');
    this.send({ type: TcpMsgType.CommandAck, payload });
  }

  reportBehaviorAlert(alert: BehaviorAlert): void {
    this.reportEvent({
      eventType: 'behaviorAlert' as any,
      details: alert as any,
    });
  }

  reportStatusUpdate(snapshot: AgentStatusSnapshot): void {
    const fullSnapshot = {
      ...snapshot,
      agentId: this.agentId,
      timestamp: new Date().toISOString(),
      destination: 'commander',
    };
    this.send({ type: TcpMsgType.StatusUpdate, payload: fullSnapshot });
  }

  destroy(): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
    }
  }
}
