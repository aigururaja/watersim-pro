/**
 * /register — the landing page with the registration popup already open.
 * The form itself lives in components/auth/RegisterForm.jsx.
 */
import LandingPage from './LandingPage';

export default function RegisterPage() {
  return <LandingPage dialog="register" />;
}
