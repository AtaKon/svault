import { useNavigate } from "react-router-dom";
import { Button, EmptyState } from "@/components/ui";
import { useI18n } from "@/i18n";

export function ExtraPages() {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <div className="py-10">
      <EmptyState
        icon="mapPin"
        title={t("This page is not in the house")}
        body={t("The link may be old, or the page moved. Everything you need is one tap away.")}
        action={
          <div className="flex gap-2">
            <Button onClick={() => navigate("/")}>{t("Go home")}</Button>
            <Button variant="secondary" onClick={() => navigate("/items")}>
              {t("Inventory")}
            </Button>
          </div>
        }
      />
    </div>
  );
}
