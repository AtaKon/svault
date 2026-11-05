import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import { useAuth } from "./state";
import { setFormatLocale } from "./format";

export type Language = "en" | "el";

const EL: Record<string, string> = {
  Home: "Αρχική",
  Inventory: "Αποθήκη",
  Scan: "Σάρωση",
  Kitchen: "Κουζίνα",
  More: "Περισσότερα",
  "Shopping list": "Λίστα αγορών",
  "Meal plan": "Πλάνο γευμάτων",
  "Bulk intake": "Μαζική εισαγωγή",
  "Food ideas": "Ιδέες φαγητού",
  Purchases: "Αγορές",
  "Photo library": "Φωτοθήκη",
  Reminders: "Υπενθυμίσεις",
  "House settings": "Ρυθμίσεις σπιτιού",
  Profile: "Προφίλ",
  Settings: "Ρυθμίσεις",
  Account: "Λογαριασμός",
  "Your profile": "Το προφίλ σου",
  "Sign out": "Αποσύνδεση",
  "Light mode": "Φωτεινή λειτουργία",
  "Dark mode": "Σκοτεινή λειτουργία",
  "Add item": "Προσθήκη αντικειμένου",
  "Add": "Προσθήκη",
  "Save": "Αποθήκευση",
  "Cancel": "Άκυρο",
  "Delete": "Διαγραφή",
  "Close": "Κλείσιμο",
  "Back": "Πίσω",
  "Search": "Αναζήτηση",
  "Loading": "Φόρτωση",
  "Everything else": "Όλα τα υπόλοιπα",
  "App": "Εφαρμογή",
  "Export data": "Εξαγωγή δεδομένων",
  "Install on this device": "Εγκατάσταση σε αυτή τη συσκευή",
  "Sign in": "Σύνδεση",
  "Create account": "Δημιουργία λογαριασμού",
  "Email": "Email",
  "Password": "Κωδικός",
  "Name": "Όνομα",
  "Welcome back": "Καλώς ήρθες",
  "Create your vault": "Δημιούργησε το θησαυροφυλάκιό σου",
  "Email or username": "Email ή όνομα χρήστη",
  "No account yet?": "Δεν έχεις λογαριασμό;",
  "Already registered?": "Έχεις ήδη λογαριασμό;",
  "Two-factor authentication": "Έλεγχος ταυτότητας δύο παραγόντων",
  "Authentication code": "Κωδικός επαλήθευσης",
  "Verify": "Επαλήθευση",
  "Use a backup code": "Χρήση εφεδρικού κωδικού",
  "Passkey": "Passkey",
  "Sign in with a passkey": "Σύνδεση με passkey",
  "Single sign-on": "Ενιαία σύνδεση",
  "Dashboard": "Πίνακας",
  "Running low": "Χαμηλό απόθεμα",
  "Rooms & places": "Δωμάτια & θέσεις",
  "Use it up": "Χρησιμοποίησέ το",
  "This week": "Αυτή την εβδομάδα",
  "Cook something": "Μαγείρεψε κάτι",
  "Recent activity": "Πρόσφατη δραστηριότητα",
  "Items": "Αντικείμενα",
  "Batches": "Παρτίδες",
  "Stock value": "Αξία αποθέματος",
  "Add low stock": "Προσθήκη χαμηλών",
  "See all": "Όλα",
  "Add to list": "Στη λίστα",
  "Open plan": "Άνοιγμα πλάνου",
  "Get ideas": "Πάρε ιδέες",
  "Scan receipt": "Σάρωση απόδειξης",
  "Add the first line": "Πρόσθεσε την πρώτη γραμμή",
  "Nothing to buy": "Δεν υπάρχει κάτι για αγορά",
  "Show checked items": "Εμφάνιση αγορασμένων",
  "Clear checked": "Καθαρισμός αγορασμένων",
  "Just check off": "Απλή σημείωση",
  "Add to stock": "Προσθήκη στο απόθεμα",
  "Add line": "Προσθήκη γραμμής",
  "Save line": "Αποθήκευση γραμμής",
  "Quantity": "Ποσότητα",
  "Unit": "Μονάδα",
  "Price": "Τιμή",
  "Place": "Θέση",
  "Expiry": "Λήξη",
  "Note": "Σημείωση",
  "Breakfast": "Πρωινό",
  "Lunch": "Μεσημεριανό",
  "Dinner": "Βραδινό",
  "Snacks": "Σνακ",
  "Previous week": "Προηγούμενη εβδομάδα",
  "Next week": "Επόμενη εβδομάδα",
  "Plan a meal": "Σχεδίασε γεύμα",
  "Move meal": "Μετακίνηση γεύματος",
  "Add to plan": "Προσθήκη στο πλάνο",
  "Servings": "Μερίδες",
  "Recipe": "Συνταγή",
  "Food idea": "Ιδέα φαγητού",
  "Custom": "Προσαρμοσμένο",
  "Day": "Ημέρα",
  "Meal": "Γεύμα",
  "Review": "Έλεγχος",
  "Commit": "Καταχώριση",
  "Receipt or text": "Απόδειξη ή κείμενο",
  "Barcode queue": "Ουρά barcode",
  "Read a photo": "Ανάγνωση φωτογραφίας",
  "Parse lines": "Ανάλυση γραμμών",
  "Queue": "Ουρά",
  "Nothing to review yet": "Δεν υπάρχει κάτι για έλεγχο",
  "Create item": "Δημιουργία αντικειμένου",
  "Update stock": "Ενημέρωση αποθέματος",
  "Skip": "Παράλειψη",
  "General": "Γενικά",
  "Places": "Θέσεις",
  "Categories": "Κατηγορίες",
  "Attributes": "Χαρακτηριστικά",
  "Members": "Μέλη",
  "AI": "AI",
  "Data": "Δεδομένα",
  "Reminder settings saved": "Οι ρυθμίσεις υπενθυμίσεων αποθηκεύτηκαν",
  "Delivery channels": "Κανάλια παράδοσης",
  "Send test": "Δοκιμαστική αποστολή",
  "Save channels": "Αποθήκευση καναλιών",
  "Import inventory CSV": "Εισαγωγή αποθέματος CSV",
  "Choose file": "Επιλογή αρχείου",
  "Import": "Εισαγωγή",
  "Export": "Εξαγωγή",
  "Inventory CSV": "CSV αποθέματος",
  "People in this house": "Άτομα σε αυτό το σπίτι",
  "Invite someone": "Πρόσκληση ατόμου",
  "Invite": "Πρόσκληση",
  "Make owner": "Ορισμός ως ιδιοκτήτη",
  "Transfer ownership": "Μεταβίβαση ιδιοκτησίας",
  "Two-factor enabled": "Ενεργός έλεγχος δύο παραγόντων",
  "Passkeys": "Passkeys",
  "Add a passkey": "Προσθήκη passkey",
  "Language": "Γλώσσα",
  "English": "Αγγλικά",
  "Greek": "Ελληνικά",
  "Save language": "Αποθήκευση γλώσσας",
  "Offline queue": "Ουρά εκτός σύνδεσης",
  "Sync now": "Συγχρονισμός",
  "Discard": "Απόρριψη",
  "Backup & restore": "Αντίγραφο & επαναφορά",
  "Download backup": "Λήψη αντιγράφου",
  "Restore backup": "Επαναφορά αντιγράφου",
  "Import dataset": "Εισαγωγή dataset",
  "Review labels": "Έλεγχος ετικετών",
  "Unlabeled": "Χωρίς ετικέτα",
  "Classification only": "Μόνο ταξινόμηση",
  "Delete selected": "Διαγραφή επιλεγμένων",
  "Assign split": "Ανάθεση split",
  "Rename label": "Μετονομασία ετικέτας",
  "Merge label": "Συγχώνευση ετικέτας",
};

interface I18nValue {
  language: Language;
  locale: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  setLanguage: (language: Language) => Promise<void>;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLanguage(userLanguage?: string | null): Language {
  if (userLanguage === "el" || userLanguage === "en") return userLanguage;
  try {
    const stored = localStorage.getItem("sv-language");
    if (stored === "el" || stored === "en") return stored;
  } catch {
    /* ignore */
  }
  if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("el")) return "el";
  return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [language, setLanguageState] = useState<Language>(() => initialLanguage(user?.language));

  const apply = useCallback((next: Language) => {
    setLanguageState(next);
    setFormatLocale(next === "el" ? "el-GR" : "en");
    if (typeof document !== "undefined") document.documentElement.lang = next;
    try {
      localStorage.setItem("sv-language", next);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (user?.language === "el" || user?.language === "en") apply(user.language);
    else apply(initialLanguage(user?.language));
  }, [user?.language, apply]);

  const setLanguage = useCallback(
    async (next: Language) => {
      apply(next);
      if (!user) return;
      try {
        await api("/api/auth/me", { method: "PATCH", body: { language: next } });
      } catch {
        /* keep the local choice even if the profile update fails */
      }
    },
    [apply, user],
  );

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const template = language === "el" ? (EL[key] ?? key) : key;
      if (!vars) return template;
      return Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template);
    },
    [language],
  );

  const value = useMemo<I18nValue>(
    () => ({ language, locale: language === "el" ? "el-GR" : "en", t, setLanguage }),
    [language, t, setLanguage],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}

export const GREEK_DICTIONARY = EL;
