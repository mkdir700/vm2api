import { useAuthStore } from '@/stores/auth-store'
import { useLayout } from '@/context/layout-provider'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarRail,
} from '@/components/ui/sidebar'
import { navGroupsFor, sidebarData } from './data/sidebar-data'
import { NavGroup } from './nav-group'
import { NavUser } from './nav-user'

export function AppSidebar() {
  const { collapsible, variant } = useLayout()
  const me = useAuthStore((s) => s.me)
  const userName = useAuthStore((s) => s.user) || me?.user || 'admin'
  const groups = navGroupsFor(me?.views)
  return (
    <Sidebar collapsible={collapsible} variant={variant}>
      <SidebarContent>
        {groups.map((group) => (
          <NavGroup key={group.title} {...group} />
        ))}
      </SidebarContent>
      <SidebarFooter>
        <NavUser
          user={{
            name: userName,
            email: me?.role || sidebarData.user.email,
            avatar: '',
          }}
          views={me?.views}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
