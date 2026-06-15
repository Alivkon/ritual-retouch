export interface User {
  user_id: number;
  username: string | null;
  email: string | null;
  balance: number;
  free_generations: number;
  total_generations: number;
  has_package: boolean;
  package_code: string | null;
  package_title: string | null;
  package_generations_total: number;
  package_generations_remaining: number;
}

export interface Generation {
  id: number;
  status: "processing" | "completed" | "failed";
  prompt: string;
  source_file_id: string | null;
  result_file_id: string | null;
  cost: number;
  is_free: number;
  created_at: string;
  completed_at: string | null;
}

export interface GenerationStatus {
  status: "processing" | "completed" | "failed";
  source_url: string | null;
  result_url: string | null;
}

export interface AuthResponse {
  token: string;
  expires_at: string;
  user: User;
}
