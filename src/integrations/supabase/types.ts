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
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      ai_sessions: {
        Row: {
          created_at: string
          id: string
          messages: Json
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          messages?: Json
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          messages?: Json
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_strategy_generations: {
        Row: {
          created_at: string
          id: string
          model: string | null
          output: Json | null
          prompt: string
          session_id: string | null
          strategy_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          model?: string | null
          output?: Json | null
          prompt: string
          session_id?: string | null
          strategy_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          model?: string | null
          output?: Json | null
          prompt?: string
          session_id?: string | null
          strategy_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_strategy_generations_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "ai_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_strategy_generations_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          created_at: string
          details: Json
          entity_id: string | null
          entity_type: string | null
          id: string
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          details?: Json
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          details?: Json
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          user_id?: string | null
        }
        Relationships: []
      }
      backtest_results: {
        Row: {
          avg_loss: number | null
          avg_win: number | null
          backtest_id: string
          created_at: string
          equity_curve: Json
          id: string
          max_drawdown_pct: number | null
          net_profit: number | null
          profit_factor: number | null
          total_return_pct: number | null
          total_trades: number | null
          trade_log: Json
          user_id: string
          win_rate_pct: number | null
        }
        Insert: {
          avg_loss?: number | null
          avg_win?: number | null
          backtest_id: string
          created_at?: string
          equity_curve?: Json
          id?: string
          max_drawdown_pct?: number | null
          net_profit?: number | null
          profit_factor?: number | null
          total_return_pct?: number | null
          total_trades?: number | null
          trade_log?: Json
          user_id: string
          win_rate_pct?: number | null
        }
        Update: {
          avg_loss?: number | null
          avg_win?: number | null
          backtest_id?: string
          created_at?: string
          equity_curve?: Json
          id?: string
          max_drawdown_pct?: number | null
          net_profit?: number | null
          profit_factor?: number | null
          total_return_pct?: number | null
          total_trades?: number | null
          trade_log?: Json
          user_id?: string
          win_rate_pct?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "backtest_results_backtest_id_fkey"
            columns: ["backtest_id"]
            isOneToOne: true
            referencedRelation: "backtests"
            referencedColumns: ["id"]
          },
        ]
      }
      backtests: {
        Row: {
          completed_at: string | null
          created_at: string
          end_date: string
          error: string | null
          fee_pct: number
          id: string
          slippage_pct: number
          start_date: string
          starting_capital: number
          status: string
          strategy_id: string
          strategy_version: number | null
          timeframe: string
          trading_pair: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          end_date: string
          error?: string | null
          fee_pct?: number
          id?: string
          slippage_pct?: number
          start_date: string
          starting_capital: number
          status?: string
          strategy_id: string
          strategy_version?: number | null
          timeframe: string
          trading_pair: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          end_date?: string
          error?: string | null
          fee_pct?: number
          id?: string
          slippage_pct?: number
          start_date?: string
          starting_capital?: number
          status?: string
          strategy_id?: string
          strategy_version?: number | null
          timeframe?: string
          trading_pair?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "backtests_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          payload: Json
          provider: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          payload?: Json
          provider?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          payload?: Json
          provider?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      bot_configurations: {
        Row: {
          bot_id: string
          created_at: string
          daily_loss_limit_pct: number | null
          extra: Json
          id: string
          max_exposure_pct: number
          max_open_positions: number
          position_size_pct: number
          stop_loss_pct: number | null
          take_profit_pct: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          bot_id: string
          created_at?: string
          daily_loss_limit_pct?: number | null
          extra?: Json
          id?: string
          max_exposure_pct?: number
          max_open_positions?: number
          position_size_pct?: number
          stop_loss_pct?: number | null
          take_profit_pct?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          bot_id?: string
          created_at?: string
          daily_loss_limit_pct?: number | null
          extra?: Json
          id?: string
          max_exposure_pct?: number
          max_open_positions?: number
          position_size_pct?: number
          stop_loss_pct?: number | null
          take_profit_pct?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bot_configurations_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: true
            referencedRelation: "trading_bots"
            referencedColumns: ["id"]
          },
        ]
      }
      bot_logs: {
        Row: {
          bot_id: string
          created_at: string
          data: Json | null
          id: string
          level: string
          message: string
          user_id: string
        }
        Insert: {
          bot_id: string
          created_at?: string
          data?: Json | null
          id?: string
          level?: string
          message: string
          user_id: string
        }
        Update: {
          bot_id?: string
          created_at?: string
          data?: Json | null
          id?: string
          level?: string
          message?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bot_logs_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "trading_bots"
            referencedColumns: ["id"]
          },
        ]
      }
      broker_connections: {
        Row: {
          broker: string
          created_at: string
          id: string
          label: string
          last_error: string | null
          last_synced_at: string | null
          market: string
          permissions: Json
          status: Database["public"]["Enums"]["connection_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          broker: string
          created_at?: string
          id?: string
          label: string
          last_error?: string | null
          last_synced_at?: string | null
          market?: string
          permissions?: Json
          status?: Database["public"]["Enums"]["connection_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          broker?: string
          created_at?: string
          id?: string
          label?: string
          last_error?: string | null
          last_synced_at?: string | null
          market?: string
          permissions?: Json
          status?: Database["public"]["Enums"]["connection_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      connection_credentials: {
        Row: {
          ciphertext: string
          connection_id: string
          created_at: string
          iv: string
          user_id: string
        }
        Insert: {
          ciphertext: string
          connection_id: string
          created_at?: string
          iv: string
          user_id: string
        }
        Update: {
          ciphertext?: string
          connection_id?: string
          created_at?: string
          iv?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "connection_credentials_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: true
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      exchange_connections: {
        Row: {
          account_type: string
          api_key_hint: string | null
          created_at: string
          exchange: string
          id: string
          is_testnet: boolean
          label: string
          last_error: string | null
          last_synced_at: string | null
          permissions: Json
          status: Database["public"]["Enums"]["connection_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          account_type?: string
          api_key_hint?: string | null
          created_at?: string
          exchange: string
          id?: string
          is_testnet?: boolean
          label: string
          last_error?: string | null
          last_synced_at?: string | null
          permissions?: Json
          status?: Database["public"]["Enums"]["connection_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          account_type?: string
          api_key_hint?: string | null
          created_at?: string
          exchange?: string
          id?: string
          is_testnet?: boolean
          label?: string
          last_error?: string | null
          last_synced_at?: string | null
          permissions?: Json
          status?: Database["public"]["Enums"]["connection_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          id: string
          kind: string
          read_at: string | null
          title: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          kind?: string
          read_at?: string | null
          title: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          kind?: string
          read_at?: string | null
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      orders: {
        Row: {
          avg_fill_price: number | null
          bot_id: string | null
          created_at: string
          exchange: string
          exchange_connection_id: string | null
          exchange_order_id: string | null
          filled_quantity: number
          id: string
          idempotency_key: string
          mode: Database["public"]["Enums"]["trading_mode"]
          order_type: string
          price: number | null
          quantity: number
          reject_reason: string | null
          side: Database["public"]["Enums"]["order_side"]
          status: Database["public"]["Enums"]["order_status"]
          trading_pair: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avg_fill_price?: number | null
          bot_id?: string | null
          created_at?: string
          exchange: string
          exchange_connection_id?: string | null
          exchange_order_id?: string | null
          filled_quantity?: number
          id?: string
          idempotency_key: string
          mode: Database["public"]["Enums"]["trading_mode"]
          order_type: string
          price?: number | null
          quantity: number
          reject_reason?: string | null
          side: Database["public"]["Enums"]["order_side"]
          status?: Database["public"]["Enums"]["order_status"]
          trading_pair: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avg_fill_price?: number | null
          bot_id?: string | null
          created_at?: string
          exchange?: string
          exchange_connection_id?: string | null
          exchange_order_id?: string | null
          filled_quantity?: number
          id?: string
          idempotency_key?: string
          mode?: Database["public"]["Enums"]["trading_mode"]
          order_type?: string
          price?: number | null
          quantity?: number
          reject_reason?: string | null
          side?: Database["public"]["Enums"]["order_side"]
          status?: Database["public"]["Enums"]["order_status"]
          trading_pair?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "trading_bots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_exchange_connection_id_fkey"
            columns: ["exchange_connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_snapshots: {
        Row: {
          available_capital: number
          captured_at: string
          exchange_connection_id: string | null
          id: string
          mode: Database["public"]["Enums"]["trading_mode"]
          total_value: number
          unrealized_pnl: number
          user_id: string
        }
        Insert: {
          available_capital: number
          captured_at?: string
          exchange_connection_id?: string | null
          id?: string
          mode: Database["public"]["Enums"]["trading_mode"]
          total_value: number
          unrealized_pnl?: number
          user_id: string
        }
        Update: {
          available_capital?: number
          captured_at?: string
          exchange_connection_id?: string | null
          id?: string
          mode?: Database["public"]["Enums"]["trading_mode"]
          total_value?: number
          unrealized_pnl?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_snapshots_exchange_connection_id_fkey"
            columns: ["exchange_connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      positions: {
        Row: {
          bot_id: string | null
          closed_at: string | null
          current_price: number | null
          entry_price: number
          exchange: string
          exchange_connection_id: string | null
          id: string
          is_open: boolean
          mode: Database["public"]["Enums"]["trading_mode"]
          opened_at: string
          quantity: number
          side: Database["public"]["Enums"]["order_side"]
          stop_loss: number | null
          take_profit: number | null
          trading_pair: string
          unrealized_pnl: number
          updated_at: string
          user_id: string
        }
        Insert: {
          bot_id?: string | null
          closed_at?: string | null
          current_price?: number | null
          entry_price: number
          exchange: string
          exchange_connection_id?: string | null
          id?: string
          is_open?: boolean
          mode: Database["public"]["Enums"]["trading_mode"]
          opened_at?: string
          quantity: number
          side: Database["public"]["Enums"]["order_side"]
          stop_loss?: number | null
          take_profit?: number | null
          trading_pair: string
          unrealized_pnl?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          bot_id?: string | null
          closed_at?: string | null
          current_price?: number | null
          entry_price?: number
          exchange?: string
          exchange_connection_id?: string | null
          id?: string
          is_open?: boolean
          mode?: Database["public"]["Enums"]["trading_mode"]
          opened_at?: string
          quantity?: number
          side?: Database["public"]["Enums"]["order_side"]
          stop_loss?: number | null
          take_profit?: number | null
          trading_pair?: string
          unrealized_pnl?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "trading_bots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "positions_exchange_connection_id_fkey"
            columns: ["exchange_connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          base_currency: string
          created_at: string
          display_name: string | null
          id: string
          timezone: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          base_currency?: string
          created_at?: string
          display_name?: string | null
          id: string
          timezone?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          base_currency?: string
          created_at?: string
          display_name?: string | null
          id?: string
          timezone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      risk_settings: {
        Row: {
          max_daily_loss: number | null
          max_open_exposure: number | null
          max_total_positions: number | null
          trading_halted: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          max_daily_loss?: number | null
          max_open_exposure?: number | null
          max_total_positions?: number | null
          trading_halted?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          max_daily_loss?: number | null
          max_open_exposure?: number | null
          max_total_positions?: number | null
          trading_halted?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      strategies: {
        Row: {
          config: Json
          created_at: string
          current_version: number
          description: string | null
          id: string
          name: string
          source: string
          status: Database["public"]["Enums"]["strategy_status"]
          updated_at: string
          user_id: string
          validation_errors: Json
        }
        Insert: {
          config?: Json
          created_at?: string
          current_version?: number
          description?: string | null
          id?: string
          name: string
          source?: string
          status?: Database["public"]["Enums"]["strategy_status"]
          updated_at?: string
          user_id: string
          validation_errors?: Json
        }
        Update: {
          config?: Json
          created_at?: string
          current_version?: number
          description?: string | null
          id?: string
          name?: string
          source?: string
          status?: Database["public"]["Enums"]["strategy_status"]
          updated_at?: string
          user_id?: string
          validation_errors?: Json
        }
        Relationships: []
      }
      strategy_versions: {
        Row: {
          config: Json
          created_at: string
          id: string
          notes: string | null
          strategy_id: string
          user_id: string
          version: number
        }
        Insert: {
          config: Json
          created_at?: string
          id?: string
          notes?: string | null
          strategy_id: string
          user_id: string
          version: number
        }
        Update: {
          config?: Json
          created_at?: string
          id?: string
          notes?: string | null
          strategy_id?: string
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "strategy_versions_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          created_at: string
          current_period_end: string | null
          id: string
          plan: string
          provider: string | null
          provider_ref: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_period_end?: string | null
          id?: string
          plan?: string
          provider?: string | null
          provider_ref?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          current_period_end?: string | null
          id?: string
          plan?: string
          provider?: string | null
          provider_ref?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      trades: {
        Row: {
          bot_id: string | null
          close_reason: string | null
          closed_at: string | null
          created_at: string
          entry_price: number
          exchange: string
          exchange_connection_id: string | null
          exit_price: number | null
          fees: number
          id: string
          mode: Database["public"]["Enums"]["trading_mode"]
          opened_at: string
          order_id: string | null
          quantity: number
          realized_pnl: number
          side: Database["public"]["Enums"]["order_side"]
          slippage: number
          strategy_id: string | null
          trading_pair: string
          user_id: string
        }
        Insert: {
          bot_id?: string | null
          close_reason?: string | null
          closed_at?: string | null
          created_at?: string
          entry_price: number
          exchange: string
          exchange_connection_id?: string | null
          exit_price?: number | null
          fees?: number
          id?: string
          mode: Database["public"]["Enums"]["trading_mode"]
          opened_at: string
          order_id?: string | null
          quantity: number
          realized_pnl?: number
          side: Database["public"]["Enums"]["order_side"]
          slippage?: number
          strategy_id?: string | null
          trading_pair: string
          user_id: string
        }
        Update: {
          bot_id?: string | null
          close_reason?: string | null
          closed_at?: string | null
          created_at?: string
          entry_price?: number
          exchange?: string
          exchange_connection_id?: string | null
          exit_price?: number | null
          fees?: number
          id?: string
          mode?: Database["public"]["Enums"]["trading_mode"]
          opened_at?: string
          order_id?: string | null
          quantity?: number
          realized_pnl?: number
          side?: Database["public"]["Enums"]["order_side"]
          slippage?: number
          strategy_id?: string | null
          trading_pair?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trades_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "trading_bots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_exchange_connection_id_fkey"
            columns: ["exchange_connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      trading_bots: {
        Row: {
          allocated_capital: number
          created_at: string
          exchange: string
          exchange_connection_id: string | null
          id: string
          last_heartbeat_at: string | null
          mode: Database["public"]["Enums"]["trading_mode"]
          name: string
          status: Database["public"]["Enums"]["bot_status"]
          status_reason: string | null
          strategy_id: string | null
          timeframe: string
          trading_pair: string
          updated_at: string
          user_id: string
        }
        Insert: {
          allocated_capital?: number
          created_at?: string
          exchange: string
          exchange_connection_id?: string | null
          id?: string
          last_heartbeat_at?: string | null
          mode?: Database["public"]["Enums"]["trading_mode"]
          name: string
          status?: Database["public"]["Enums"]["bot_status"]
          status_reason?: string | null
          strategy_id?: string | null
          timeframe?: string
          trading_pair: string
          updated_at?: string
          user_id: string
        }
        Update: {
          allocated_capital?: number
          created_at?: string
          exchange?: string
          exchange_connection_id?: string | null
          id?: string
          last_heartbeat_at?: string | null
          mode?: Database["public"]["Enums"]["trading_mode"]
          name?: string
          status?: Database["public"]["Enums"]["bot_status"]
          status_reason?: string | null
          strategy_id?: string | null
          timeframe?: string
          trading_pair?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trading_bots_exchange_connection_id_fkey"
            columns: ["exchange_connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trading_bots_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "user" | "admin" | "super_admin"
      bot_status:
        | "draft"
        | "backtesting"
        | "paper_trading"
        | "running"
        | "paused"
        | "stopped"
        | "error"
      connection_status:
        | "pending"
        | "connected"
        | "error"
        | "expired"
        | "disconnected"
      order_side: "buy" | "sell"
      order_status:
        | "pending"
        | "open"
        | "partially_filled"
        | "filled"
        | "cancelled"
        | "rejected"
      strategy_status:
        | "draft"
        | "validated"
        | "invalid"
        | "deployed"
        | "archived"
      trading_mode: "paper" | "live"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
      app_role: ["user", "admin", "super_admin"],
      bot_status: [
        "draft",
        "backtesting",
        "paper_trading",
        "running",
        "paused",
        "stopped",
        "error",
      ],
      connection_status: [
        "pending",
        "connected",
        "error",
        "expired",
        "disconnected",
      ],
      order_side: ["buy", "sell"],
      order_status: [
        "pending",
        "open",
        "partially_filled",
        "filled",
        "cancelled",
        "rejected",
      ],
      strategy_status: [
        "draft",
        "validated",
        "invalid",
        "deployed",
        "archived",
      ],
      trading_mode: ["paper", "live"],
    },
  },
} as const
