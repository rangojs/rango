/**
 * Custom Error Classes for Host Router
 *
 * All host router errors extend HostRouterError for easy instance checking.
 */

/**
 * Error options with cause
 */
interface ErrorOptions {
  cause?: unknown;
}

/**
 * Base error class for all host router errors
 */
export class HostRouterError extends Error {
  cause?: unknown;

  constructor(message: string, options?: ErrorOptions) {
    super(message);
    if (options?.cause) {
      this.cause = options.cause;
    }
    this.name = "HostRouterError";
    Object.setPrototypeOf(this, HostRouterError.prototype);
  }
}

/**
 * Error thrown when pattern validation fails
 */
export class InvalidPatternError extends HostRouterError {
  constructor(pattern: string, reason: string, options?: ErrorOptions) {
    super(`Invalid pattern "${pattern}": ${reason}`, options);
    this.name = "InvalidPatternError";
    Object.setPrototypeOf(this, InvalidPatternError.prototype);
  }
}

/**
 * Error thrown when cookie override is not allowed
 */
export class HostOverrideNotAllowedError extends HostRouterError {
  constructor(currentHost: string, cookieName: string, options?: ErrorOptions) {
    super(
      `Host override not allowed on "${currentHost}" (cookie: ${cookieName})`,
      options,
    );
    this.name = "HostOverrideNotAllowedError";
    Object.setPrototypeOf(this, HostOverrideNotAllowedError.prototype);
  }
}

/**
 * Error thrown when cookie hostname is invalid
 */
export class InvalidHostnameError extends HostRouterError {
  constructor(hostname: string, options?: ErrorOptions) {
    super(`Invalid hostname format: "${hostname}"`, options);
    this.name = "InvalidHostnameError";
    Object.setPrototypeOf(this, InvalidHostnameError.prototype);
  }
}

/**
 * Error thrown when custom validation fails
 */
export class HostValidationError extends HostRouterError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "HostValidationError";
    Object.setPrototypeOf(this, HostValidationError.prototype);
  }
}

/**
 * Error thrown when no route matches
 */
export class NoRouteMatchError extends HostRouterError {
  constructor(hostname: string, pathname: string, options?: ErrorOptions) {
    super(`No route matched for ${hostname}${pathname}`, options);
    this.name = "NoRouteMatchError";
    Object.setPrototypeOf(this, NoRouteMatchError.prototype);
  }
}

/**
 * Error thrown when handler type is invalid
 */
export class InvalidHandlerError extends HostRouterError {
  constructor(handler: unknown, options?: ErrorOptions) {
    super(`Invalid handler type: ${typeof handler}`, options);
    this.name = "InvalidHandlerError";
    Object.setPrototypeOf(this, InvalidHandlerError.prototype);
  }
}
