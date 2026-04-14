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
  exchange_connections: ExchangeConnection[];
  has_validated_connection: boolean;
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
