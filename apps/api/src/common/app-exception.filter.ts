import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
  BotControlError,
  ConflictError,
  InvalidStateTransitionError,
  LiveConfigurationError,
  NotFoundError,
  ReadinessError,
} from './errors';

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<{
      status: (code: number) => {
        json: (body: unknown) => void;
      };
    }>();

    const { statusCode, error, message } = this.mapException(exception);

    response.status(statusCode).json({
      statusCode,
      error,
      message,
    });
  }

  private mapException(exception: unknown): {
    statusCode: number;
    error: string;
    message: string;
  } {
    if (exception instanceof NotFoundError) {
      return this.build(HttpStatus.NOT_FOUND, exception);
    }

    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      const payload =
        typeof response === 'string'
          ? { message: response, error: exception.name }
          : (response as { message?: string | string[]; error?: string });

      return {
        statusCode: exception.getStatus(),
        error: payload.error ?? exception.name,
        message: Array.isArray(payload.message)
          ? payload.message.join(', ')
          : payload.message ?? exception.message,
      };
    }

    if (
      exception instanceof InvalidStateTransitionError ||
      exception instanceof ConflictError ||
      exception instanceof ReadinessError
    ) {
      return this.build(HttpStatus.CONFLICT, exception);
    }

    if (
      exception instanceof LiveConfigurationError ||
      exception instanceof BotControlError
    ) {
      return this.build(HttpStatus.BAD_REQUEST, exception);
    }

    if (exception instanceof Error) {
      return this.build(HttpStatus.INTERNAL_SERVER_ERROR, exception);
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'InternalServerError',
      message: 'Unexpected server error.',
    };
  }

  private build(statusCode: number, exception: Error) {
    return {
      statusCode,
      error: exception.name,
      message: exception.message,
    };
  }
}
