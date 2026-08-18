export class HozamoError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class HozamoConfigError extends HozamoError {}

export class HozamoValidationError extends HozamoError {}

export class HozamoApiError extends HozamoError {
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
  HozamoError as SafeTradeError,
  HozamoConfigError as SafeTradeConfigError,
  HozamoValidationError as SafeTradeValidationError,
  HozamoApiError as SafeTradeApiError,
};
