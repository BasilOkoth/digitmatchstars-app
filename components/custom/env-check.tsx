'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { useAppTranslations } from '@/components/custom/i18n-provider';

/**
 * Fires a warning toast on first mount if NEXT_PUBLIC_DERIV_APP_ID is not set.
 * A missing NEXT_PUBLIC_DERIV_REDIRECT_URI is fine: login falls back to the
 * page origin (matches trader's env-vars-check-snackbar.tsx). Skipped in
 * preview mode (NEXT_PUBLIC_PREVIEW_MODE=true) or when the current route is
 * the /preview or /edit page (the no-code builder embeds these in an iframe
 * where env vars are intentionally absent), since the warning is noise there.
 * Renders nothing — exists only for its side effect.
 *
 * Mounted inside TemplateLayout so every template app gets this check
 * automatically.
 */
export function EnvCheck() {
  const { localize } = useAppTranslations();

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_PREVIEW_MODE === 'true') return;
    if (
      window.location.pathname.includes('/preview') ||
      window.location.pathname.includes('/edit')
    )
      return;
    if (!process.env.NEXT_PUBLIC_DERIV_APP_ID) {
      toast.warning(localize('Waiting for environment variables to be set…'));
    }
  }, [localize]);

  return null;
}
