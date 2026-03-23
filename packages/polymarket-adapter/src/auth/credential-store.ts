import { L2Credentials } from './l2-credentials';

export class CredentialStore {
  private credentials: L2Credentials | null = null;

  load(): L2Credentials | null {
    return this.credentials;
  }

  save(credentials: L2Credentials): void {
    this.credentials = credentials;
  }

  clear(): void {
    this.credentials = null;
  }

  hasCredentials(): boolean {
    return this.credentials !== null;
  }
}
