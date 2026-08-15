export class SpotPilotError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class SpotPilotConfigError extends SpotPilotError {}

export class SpotPilotValidationError extends SpotPilotError {}

export class SpotPilotApiError extends SpotPilotError {
  constructor(message, {
    exchange = null,
    status = null,
    method = null,
    url = null,
    response = null,
    code = null,
    apiCode = null,
    rayId = null,
    cause,
  } = {}) {
    super(message, { cause });
    this.exchange = exchange;
    this.status = status;
    this.method = method;
    this.url = url;
    this.response = response;
    this.code = code;
    this.apiCode = apiCode;
    this.rayId = rayId;
  }
}

// Backward-compatible names for users of the v0.2 SafeTrade client.
export {
  SpotPilotError as SafeTradeError,
  SpotPilotConfigError as SafeTradeConfigError,
  SpotPilotValidationError as SafeTradeValidationError,
  SpotPilotApiError as SafeTradeApiError,
};
