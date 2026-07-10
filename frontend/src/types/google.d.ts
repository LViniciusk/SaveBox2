/* eslint-disable @typescript-eslint/no-namespace */

/**
 * Google Identity Services (GIS) — Type Declarations
 * @see https://developers.google.com/identity/gsi/web/reference/js-reference
 */
declare namespace google {
  namespace accounts {
    namespace id {
      interface GsiButtonConfiguration {
        type?: 'standard' | 'icon';
        theme?: 'outline' | 'filled_blue' | 'filled_black';
        size?: 'large' | 'medium' | 'small';
        text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
        shape?: 'rectangular' | 'pill' | 'circle' | 'square';
        logo_alignment?: 'left' | 'center';
        width?: string | number;
        locale?: string;
      }

      interface CredentialResponse {
        credential: string;
        select_by: string;
        clientId: string;
      }

      interface IdConfiguration {
        client_id: string;
        auto_select?: boolean;
        callback?: (response: CredentialResponse) => void;
        login_uri?: string;
        native_callback?: (response: CredentialResponse) => void;
        cancel_on_tap_outside?: boolean;
        prompt_parent_id?: string;
        nonce?: string;
        context?: 'signin' | 'signup' | 'use';
        state_cookie_domain?: string;
        ux_mode?: 'popup' | 'redirect';
        allowed_parent_origin?: string | string[];
        itp_support?: boolean;
      }

      interface PromptMomentNotification {
        isDisplayMoment(): boolean;
        isDisplayed(): boolean;
        isNotDisplayed(): boolean;
        getNotDisplayedReason(): string;
        isSkippedMoment(): boolean;
        getSkippedReason(): string;
        isDismissedMoment(): boolean;
        getDismissedReason(): string;
      }

      function initialize(input: IdConfiguration): void;
      function prompt(momentListener?: (notification: PromptMomentNotification) => void): void;
      function renderButton(parent: HTMLElement, options: GsiButtonConfiguration): void;
      function disableAutoSelect(): void;
      function storeCredential(
        credential: { id: string; password: string },
        callback?: () => void,
      ): void;
      function cancel(): void;
      function revoke(
        hint: string,
        callback?: (response: { successful: boolean; error?: string }) => void,
      ): void;
    }
  }
}
