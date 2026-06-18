interface ExchangeConnection {
  id: number;
  exchange_name: string;
  label: string;
  is_validated: boolean;
  is_sandbox: boolean;
  keys_last_validated: string | null;
  created_at: string;
}

interface UserModel {
  id: number;
  username: string;
  created_at: string;
  updated_at: string;
  last_login: string;
  notifications_enabled: boolean;
  donation_modal_enabled: boolean;
  is_active: boolean;
  theme: 'dark' | 'light';
  email_notifications_enabled: boolean;
  notify_email: string | null;
  smtp_password_set: boolean;
  smtp_host: string | null;
  smtp_port: number | null;
  exchange_connections: ExchangeConnection[];
  has_validated_connection: boolean;
}

interface EmailNotificationSettings {
  email_notifications_enabled: boolean;
  notify_email: string;
  // Only sent when the user types a new password; omit to keep the stored one.
  smtp_password?: string;
  smtp_host?: string;
  smtp_port?: number | null;
}

interface AccountSummary {
  id: number;
  username: string;
  created_at: string | null;
  is_active: boolean;
  command_count: number;
}

interface LoginResponse {
  token: string;
  user: UserModel;
}

interface RegisterRequest {
  username: string;
  password: string;
}

interface LoginRequest {
  username: string;
  password: string;
}

interface ApiResponse<T = any> {
  status: string;
  result: string;
  data: T;
}
