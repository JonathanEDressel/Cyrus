interface UserModel {
  id: number;
  username: string;
  created_at: string;
  updated_at: string;
  last_login: string;
  has_keys: boolean;
  keys_validated: boolean;
  keys_last_validated: string | null;
}

interface LoginResponse {
  token: string;
  user: UserModel;
}

interface RegisterRequest {
  username: string;
  password: string;
  krakenApiKey: string;
  krakenPrivateKey: string;
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
