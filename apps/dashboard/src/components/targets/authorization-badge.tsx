import { TbShieldCheck, TbShieldOff } from 'react-icons/tb';

import { Badge } from '@/components/ui/badge';

export function AuthorizationBadge({ authorized }: { readonly authorized: boolean }) {
  return authorized ? (
    <Badge variant="success">
      <TbShieldCheck className="size-3" />
      Authorized
    </Badge>
  ) : (
    <Badge variant="muted">
      <TbShieldOff className="size-3" />
      Unauthorized
    </Badge>
  );
}
