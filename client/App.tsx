import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "@/state";
import { AppShell } from "@/components/AppShell";
import { LogoMark } from "@/components/icons";
import { Spinner } from "@/components/ui";
import { AuthPage, JoinPage, NoHousePage } from "@/pages/AuthPages";
import { DashboardPage } from "@/pages/DashboardPage";
import { InventoryPage } from "@/pages/InventoryPage";
import { ItemPage } from "@/pages/ItemPage";
import { ItemFormPage } from "@/pages/ItemFormPage";
import { ScanPage } from "@/pages/ScanPage";
import { ReceiptsPage } from "@/pages/ReceiptsPage";
import { BillsPage } from "@/pages/BillsPage";
import { ReceiptScanPage } from "@/pages/ReceiptScanPage";
import { ReceiptTemplateFormPage } from "@/pages/ReceiptTemplateFormPage";
import { RecipesPage } from "@/pages/RecipesPage";
import { RecipePage } from "@/pages/RecipePage";
import { RecipeFormPage } from "@/pages/RecipeFormPage";
import { RecipeScanPage } from "@/pages/RecipeScanPage";
import { IdeasPage } from "@/pages/IdeasPage";
import { PhotosPage } from "@/pages/PhotosPage";
import { NotificationsPage } from "@/pages/NotificationsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { ProfilePage } from "@/pages/ProfilePage";
import { DeveloperPage } from "@/pages/DeveloperPage";
import { MorePage } from "@/pages/MorePage";
import { ExtraPages } from "@/pages/ExtraPages";
import { ShoppingPage } from "@/pages/ShoppingPage";
import { PlanPage } from "@/pages/PlanPage";
import { IntakePage } from "@/pages/IntakePage";
import { InsightsPage } from "@/pages/InsightsPage";
import { AdminPage } from "@/pages/AdminPage";
import { useI18n } from "@/i18n";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route path="/join/:code" element={<JoinPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="/items" element={<InventoryPage />} />
        <Route path="/items/new" element={<ItemFormPage />} />
        <Route path="/items/:itemId" element={<ItemPage />} />
        <Route path="/items/:itemId/edit" element={<ItemFormPage />} />
        <Route path="/scan" element={<ScanPage />} />
        <Route path="/receipts" element={<ReceiptsPage />} />
        <Route path="/bills" element={<BillsPage />} />
        <Route path="/receipts/scan" element={<ReceiptScanPage />} />
        <Route path="/receipts/templates/new" element={<ReceiptTemplateFormPage />} />
        <Route path="/receipts/templates/:templateId" element={<ReceiptTemplateFormPage />} />
        <Route path="/recipes" element={<RecipesPage />} />
        <Route path="/recipes/new" element={<RecipeFormPage />} />
        <Route path="/recipes/scan" element={<RecipeScanPage />} />
        <Route path="/recipes/:recipeId" element={<RecipePage />} />
        <Route path="/recipes/:recipeId/edit" element={<RecipeFormPage />} />
        <Route path="/ideas" element={<IdeasPage />} />
        <Route path="/shopping" element={<ShoppingPage />} />
        <Route path="/plan" element={<PlanPage />} />
        <Route path="/intake" element={<IntakePage />} />
        <Route path="/insights" element={<InsightsPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/photos" element={<PhotosPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/developer" element={<DeveloperPage />} />
        <Route path="/more" element={<MorePage />} />
        <Route path="*" element={<ExtraPages />} />
      </Route>
    </Routes>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { user, loading, house } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg">
        <LogoMark size={44} />
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner size={14} />
          <span role="status">{t("Opening your vault")}</span>
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!house) return <NoHousePage />;
  return <>{children}</>;
}
