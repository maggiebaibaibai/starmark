/** Only explicitly classified client errors may cross the HTTP boundary. */
export class ValidationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
