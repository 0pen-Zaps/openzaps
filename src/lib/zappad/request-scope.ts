export interface ScopedRequest {
  scope: string;
  version: number;
}

export class RequestScopeGate {
  private scope = "";
  private version = 0;

  activate(scope: string) {
    if (scope !== this.scope) {
      this.scope = scope;
      this.version += 1;
    }
  }

  begin(scope: string): ScopedRequest {
    this.activate(scope);
    this.version += 1;
    return { scope, version: this.version };
  }

  isCurrent(request: ScopedRequest) {
    return (
      request.scope === this.scope && request.version === this.version
    );
  }
}
