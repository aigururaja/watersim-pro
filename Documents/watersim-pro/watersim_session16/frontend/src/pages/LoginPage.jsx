/**
 * /login — in a browser, the landing page with the sign-in popup already
 * open, so every link and redirect to /login still lands on the form; inside
 * the installed app, a plain sign-in screen with no landing page. The form
 * itself lives in components/auth/LoginForm.jsx.
 */
import LandingPage from './LandingPage';
import AuthScreen from '../components/auth/AuthScreen';
import { isInstalledApp } from '../utils/appMode';

export { loginErrorMessage } from '../components/auth/LoginForm';

export default function LoginPage() {
  return isInstalledApp() ? <AuthScreen mode="login" /> : <LandingPage dialog="login" />;
}
