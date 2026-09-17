/**
 * /register — in a browser, the landing page with the registration popup
 * already open; inside the installed app, a plain registration screen.
 * The form itself lives in components/auth/RegisterForm.jsx.
 */
import LandingPage from './LandingPage';
import AuthScreen from '../components/auth/AuthScreen';
import { isInstalledApp } from '../utils/appMode';

export default function RegisterPage() {
  return isInstalledApp() ? <AuthScreen mode="register" /> : <LandingPage dialog="register" />;
}
