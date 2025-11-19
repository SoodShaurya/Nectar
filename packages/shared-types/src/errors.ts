/**
 * Base Application Error
 */
export class ApplicationError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public isOperational: boolean = true
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Configuration Error - thrown when configuration is invalid
 */
export class ConfigurationError extends ApplicationError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR', 500, true);
  }
}

/**
 * Connection Error - thrown when connection to external service fails
 */
export class ConnectionError extends ApplicationError {
  constructor(message: string, public service: string) {
    super(message, 'CONNECTION_ERROR', 503, true);
  }
}

/**
 * Validation Error - thrown when input validation fails
 */
export class ValidationError extends ApplicationError {
  constructor(message: string, public details?: any) {
    super(message, 'VALIDATION_ERROR', 400, true);
  }
}

/**
 * LLM Error - thrown when LLM API calls fail
 */
export class LLMError extends ApplicationError {
  constructor(message: string, public provider: string) {
    super(message, 'LLM_ERROR', 502, true);
  }
}

/**
 * Task Execution Error - thrown when agent task execution fails
 */
export class TaskExecutionError extends ApplicationError {
  constructor(message: string, public taskType: string, public agentId?: string) {
    super(message, 'TASK_EXECUTION_ERROR', 500, true);
  }
}

/**
 * Agent Error - thrown when agent encounters an error
 */
export class AgentError extends ApplicationError {
  constructor(message: string, public agentId: string) {
    super(message, 'AGENT_ERROR', 500, true);
  }
}

/**
 * Circuit Breaker Open Error - thrown when circuit breaker is open
 */
export class CircuitBreakerError extends ApplicationError {
  constructor(service: string) {
    super(`Circuit breaker is OPEN for ${service}`, 'CIRCUIT_BREAKER_OPEN', 503, true);
  }
}

/**
 * Rate Limit Error - thrown when rate limit is exceeded
 */
export class RateLimitError extends ApplicationError {
  constructor(message: string) {
    super(message, 'RATE_LIMIT_ERROR', 429, true);
  }
}

/**
 * Error Handler - logs and handles errors appropriately
 */
export function handleError(error: Error, logger?: any): void {
  if (error instanceof ApplicationError) {
    if (error.isOperational) {
      logger?.error(`Operational error: ${error.message}`, {
        code: error.code,
        statusCode: error.statusCode,
        stack: error.stack,
      });
    } else {
      logger?.error(`Programmer error: ${error.message}`, {
        code: error.code,
        stack: error.stack,
      });
      // In production, you might want to exit process for non-operational errors
      if (process.env.NODE_ENV === 'production') {
        process.exit(1);
      }
    }
  } else {
    logger?.error(`Unexpected error: ${error.message}`, { stack: error.stack });
  }
}
