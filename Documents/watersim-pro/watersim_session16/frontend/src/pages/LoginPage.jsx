/**
 * /login — the landing page with the sign-in popup already open, so every
 * link and redirect to /login still lands on the form. The form itself lives
 * in components/auth/LoginForm.jsx.
 */
import LandingPage from './LandingPage';

export { loginErrorMessage } from '../components/auth/LoginForm';

export default function LoginPage() {
  return <LandingPage dialog="login" />;
}
