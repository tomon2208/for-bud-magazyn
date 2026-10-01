import { logoutAction } from "@/server/auth-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function LogoutButton({ className, size }: { className?: string; size?: "default" | "lg" }) {
  return (
    <form action={logoutAction}>
      <Button type="submit" variant="outline" size={size} className={cn(className)}>
        Wyloguj
      </Button>
    </form>
  );
}
