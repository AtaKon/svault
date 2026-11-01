import { useNavigate } from "react-router-dom";
import { Button, EmptyState } from "@/components/ui";

export function ExtraPages() {
  const navigate = useNavigate();
  return (
    <div className="py-10">
      <EmptyState
        icon="mapPin"
        title="This page is not in the house"
        body="The link may be old, or the page moved. Everything you need is one tap away."
        action={
          <div className="flex gap-2">
            <Button onClick={() => navigate("/")}>Go home</Button>
            <Button variant="secondary" onClick={() => navigate("/items")}>
              Inventory
            </Button>
          </div>
        }
      />
    </div>
  );
}
