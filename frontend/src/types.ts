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
  can_review_media?: boolean;
}

export interface Generation {
  id: number;
  status: "processing" | "completed" | "failed" | "deleted";
  prompt: string;
  source_file_id: string | null;
  result_file_id: string | null;
  cost: number;
  is_free: number;
  created_at: string;
  completed_at: string | null;
  source_url?: string | null;
  result_url?: string | null;
}

export interface GenerationStatus {
  status: "processing" | "completed" | "failed" | "deleted";
  source_url: string | null;
  result_url: string | null;
}

export interface AuthResponse {
  token: string;
  expires_at: string;
  user: User;
}


export interface ReviewGenerationResponse {
  page: number;
  limit: number;
  items: Generation[];
}

export interface InternalGeneration extends Generation {
  user_id?: number;
  email?: string | null;
  username?: string | null;
}

export interface InternalMediaPair {
  source_filename: string;
  result_filename: string;
  source_url: string;
  result_url: string;
  created_at: string;
  orphan: boolean;
  generation: InternalGeneration | null;
}

export interface InternalGenerationsResponse {
  page: number;
  limit: number;
  items: InternalMediaPair[];
}
