UPDATE auth.users
SET encrypted_password = crypt('Admin2026!', gen_salt('bf')),
    updated_at = now()
WHERE email IN ('andres.gaitan@ampm.com.ni', 'marco.lopez@ampmcentroamerica.com');