export class BotControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotControlError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateTransitionError';
  }
}

export class LiveConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveConfigurationError';
  }
}

export class ReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadinessError';
  }
}