export class ControllerUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControllerUnreachable';
  }
}

export class ControllerUnauthorized extends Error {
  constructor(message = 'controller rejected the password') {
    super(message);
    this.name = 'ControllerUnauthorized';
  }
}

export class ControllerRejected extends Error {
  constructor(public result: number) {
    super(`controller rejected the request (result ${result})`);
    this.name = 'ControllerRejected';
  }
}
