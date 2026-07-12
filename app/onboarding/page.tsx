// Onboarding wizard route. app/page.tsx router.replaces here for teams with no
// brands. GeoHeader renders at layout level — this page renders only the wizard.
import OnboardingWizard from "./OnboardingWizard";

export default function OnboardingPage() {
  return <OnboardingWizard />;
}
