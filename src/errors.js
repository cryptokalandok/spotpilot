export class SafeTradeError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class SafeTradeConfigError extends SafeTradeError {}

export class SafeTradeValidationError extends SafeTradeError {}

export class SafeTradeApiError extends SafeTradeError {
  constructor(message, {
    status = null,
    method = null,
    url = null,
    response = null,
    code = null,
    rayId = null,
    cause,
  } = {}) {
    super(message, { cause });
    this.status = status;
    this.method = method;
    this.url = url;
    this.response = response;
    this.code = code;
    this.rayId = rayId;
  }
}
