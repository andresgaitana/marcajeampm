export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      attendance_records: {
        Row: {
          auth_method: Database["public"]["Enums"]["auth_method"]
          created_at: string
          employee_id: string
          face_override_by: string | null
          id: string
          latitude: number | null
          location_accuracy_m: number | null
          location_valid: boolean
          longitude: number | null
          notes: string | null
          selfie_url: string | null
          store_id: string
          type: Database["public"]["Enums"]["attendance_type"]
        }
        Insert: {
          auth_method?: Database["public"]["Enums"]["auth_method"]
          created_at?: string
          employee_id: string
          face_override_by?: string | null
          id?: string
          latitude?: number | null
          location_accuracy_m?: number | null
          location_valid?: boolean
          longitude?: number | null
          notes?: string | null
          selfie_url?: string | null
          store_id: string
          type: Database["public"]["Enums"]["attendance_type"]
        }
        Update: {
          auth_method?: Database["public"]["Enums"]["auth_method"]
          created_at?: string
          employee_id?: string
          face_override_by?: string | null
          id?: string
          latitude?: number | null
          location_accuracy_m?: number | null
          location_valid?: boolean
          longitude?: number | null
          notes?: string | null
          selfie_url?: string | null
          store_id?: string
          type?: Database["public"]["Enums"]["attendance_type"]
        }
        Relationships: [
          {
            foreignKeyName: "attendance_records_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_records_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_credentials: {
        Row: {
          counter: number
          created_at: string
          credential_id: string
          device_label: string | null
          employee_id: string
          id: string
          last_used_at: string | null
          public_key: string
          transports: string | null
        }
        Insert: {
          counter?: number
          created_at?: string
          credential_id: string
          device_label?: string | null
          employee_id: string
          id?: string
          last_used_at?: string | null
          public_key: string
          transports?: string | null
        }
        Update: {
          counter?: number
          created_at?: string
          credential_id?: string
          device_label?: string | null
          employee_id?: string
          id?: string
          last_used_at?: string | null
          public_key?: string
          transports?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employee_credentials_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_store_assignments: {
        Row: {
          created_at: string
          employee_id: string
          id: string
          store_id: string
        }
        Insert: {
          created_at?: string
          employee_id: string
          id?: string
          store_id: string
        }
        Update: {
          created_at?: string
          employee_id?: string
          id?: string
          store_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_store_assignments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_store_assignments_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      employees: {
        Row: {
          active: boolean
          created_at: string
          employee_code: string
          face_descriptor: number[] | null
          face_enrolled_at: string | null
          failed_selfie_attempts: number
          full_name: string
          id: string
          must_change_pin: boolean
          password_hash: string | null
          pin_hash: string
          role: Database["public"]["Enums"]["employee_role"]
          selfie_blocked_until: string | null
          store: string | null
          store_id: string
          updated_at: string
          username: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          employee_code: string
          face_descriptor?: number[] | null
          face_enrolled_at?: string | null
          failed_selfie_attempts?: number
          full_name: string
          id?: string
          must_change_pin?: boolean
          password_hash?: string | null
          pin_hash: string
          role?: Database["public"]["Enums"]["employee_role"]
          selfie_blocked_until?: string | null
          store?: string | null
          store_id: string
          updated_at?: string
          username?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          employee_code?: string
          face_descriptor?: number[] | null
          face_enrolled_at?: string | null
          failed_selfie_attempts?: number
          full_name?: string
          id?: string
          must_change_pin?: boolean
          password_hash?: string | null
          pin_hash?: string
          role?: Database["public"]["Enums"]["employee_role"]
          selfie_blocked_until?: string | null
          store?: string | null
          store_id?: string
          updated_at?: string
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employees_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      store_managers: {
        Row: {
          created_at: string
          id: string
          store_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          store_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          store_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "store_managers_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id"]
          },
        ]
      }
      stores: {
        Row: {
          active: boolean
          address: string | null
          code: string
          created_at: string
          geofence_radius_m: number
          id: string
          latitude: number | null
          longitude: number | null
          name: string
          terminal_pin_hash: string
          updated_at: string
          zone_id: string | null
        }
        Insert: {
          active?: boolean
          address?: string | null
          code: string
          created_at?: string
          geofence_radius_m?: number
          id?: string
          latitude?: number | null
          longitude?: number | null
          name: string
          terminal_pin_hash: string
          updated_at?: string
          zone_id?: string | null
        }
        Update: {
          active?: boolean
          address?: string | null
          code?: string
          created_at?: string
          geofence_radius_m?: number
          id?: string
          latitude?: number | null
          longitude?: number | null
          name?: string
          terminal_pin_hash?: string
          updated_at?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stores_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "zones"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      user_zone_assignments: {
        Row: {
          created_at: string
          id: string
          user_id: string
          zone_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          user_id: string
          zone_id: string
        }
        Update: {
          created_at?: string
          id?: string
          user_id?: string
          zone_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_zone_assignments_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "zones"
            referencedColumns: ["id"]
          },
        ]
      }
      webauthn_challenges: {
        Row: {
          challenge: string
          created_at: string
          employee_id: string | null
          expires_at: string
          id: string
          purpose: string
        }
        Insert: {
          challenge: string
          created_at?: string
          employee_id?: string | null
          expires_at?: string
          id?: string
          purpose: string
        }
        Update: {
          challenge?: string
          created_at?: string
          employee_id?: string | null
          expires_at?: string
          id?: string
          purpose?: string
        }
        Relationships: [
          {
            foreignKeyName: "webauthn_challenges_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      zones: {
        Row: {
          active: boolean
          code: string
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accessible_store_ids: {
        Args: { _user_id: string }
        Returns: {
          store_id: string
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_store_manager: {
        Args: { _store_id: string; _user_id: string }
        Returns: boolean
      }
      is_zone_user: {
        Args: { _user_id: string; _zone_id: string }
        Returns: boolean
      }
    }
    Enums: {
      app_role:
        | "admin"
        | "gerente_tienda"
        | "gerente_zona"
        | "gerente_operaciones"
      attendance_type: "entrada" | "salida"
      auth_method: "pin" | "password" | "webauthn"
      employee_role:
        | "cajero"
        | "gerente"
        | "seguridad"
        | "agente_mbk"
        | "gerente_zona"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: [
        "admin",
        "gerente_tienda",
        "gerente_zona",
        "gerente_operaciones",
      ],
      attendance_type: ["entrada", "salida"],
      auth_method: ["pin", "password", "webauthn"],
      employee_role: [
        "cajero",
        "gerente",
        "seguridad",
        "agente_mbk",
        "gerente_zona",
      ],
    },
  },
} as const
